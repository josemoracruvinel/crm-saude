-- manifest: **Cobrança da consulta pelo Asaas da clínica (1.105.0):** três tabelas server-side only — `consulta_pagamento_conexoes` (a chave Asaas da organização, cifrada por `fn_encrypt_oauth`, com o hash do token do aviso de pagamento), `consulta_pagamento_clientes` (o cliente Asaas de cada contato, por modo, para não pedir o CPF de novo) e `consulta_pagamentos` (a cobrança de cada consulta, com no máximo UMA viva por consulta). RLS ligada sem policies e grants revogados de anon/authenticated, como a 0504. Nenhuma função nova em `public`. Idempotente; espelho no fim do apêndice do `supabase/baseline.sql`.
-- ============================================================================
-- 9222 — A COBRANÇA DA CONSULTA (desenho: docs/superpowers/specs/2026-11-26-cobranca-da-consulta-asaas-design.md)
--
-- A atendente de IA marca a consulta, gera a cobrança no Asaas DA CLÍNICA e
-- manda o link; quando o pagamento cai, a consulta se confirma sozinha. O
-- dinheiro vai direto para a conta da clínica: aqui só mora o ponteiro.
--
-- Server-side only, como `map_provider_credentials` (0504): RLS ligada, zero
-- policies, grants revogados de anon/authenticated. Toda leitura passa por rota
-- que filtra `organization_id` à mão.
--
-- Nenhuma função nova em `public` ⇒ o item 9 da doutrina de migrations não é
-- acionado por este arquivo.

-- ── A conexão Asaas da organização ─────────────────────────────────────────
create table if not exists public.consulta_pagamento_conexoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'asaas',
  api_key_encrypted bytea not null,
  -- Para a tela reconhecer QUAL chave está gravada sem ver a chave.
  api_key_last4 text not null,
  -- Sai do prefixo da chave: `$aact_hmlg_` é o ambiente de teste.
  modo text not null,
  -- O aviso cadastrado na conta Asaas da clínica.
  webhook_id text,
  -- sha256 (hex) do token que o Asaas ecoa em `asaas-access-token`. O token em
  -- claro nunca é gravado: quem o tem assina avisos.
  webhook_token_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint consulta_pagamento_conexoes_provider_conhecido check (provider in ('asaas')),
  constraint consulta_pagamento_conexoes_modo_conhecido check (modo in ('teste', 'producao'))
);

create unique index if not exists consulta_pagamento_conexoes_org_uk
  on public.consulta_pagamento_conexoes (organization_id);

comment on table public.consulta_pagamento_conexoes is
  'A conta Asaas da organização para cobrar consultas dos pacientes. Opcional. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated. A chave nunca volta ao browser.';
comment on column public.consulta_pagamento_conexoes.api_key_encrypted is
  'Cifrado por fn_encrypt_oauth, a mesma cifra de map_provider_credentials.';

alter table public.consulta_pagamento_conexoes enable row level security;
revoke all on public.consulta_pagamento_conexoes from anon, authenticated;
grant select, insert, update, delete on public.consulta_pagamento_conexoes to service_role;

drop trigger if exists trg_consulta_pagamento_conexoes_updated_at on public.consulta_pagamento_conexoes;
create trigger trg_consulta_pagamento_conexoes_updated_at
  before update on public.consulta_pagamento_conexoes
  for each row execute function public.fn_set_updated_at();

-- ── O cliente Asaas de cada contato ────────────────────────────────────────
-- O CPF cifrado da ficha não volta ao servidor (`decrypt_cpf` exige sessão de
-- gente). Guardar o id do cliente no Asaas é o que deixa a segunda consulta
-- sair sem pedir o CPF de novo.
create table if not exists public.consulta_pagamento_clientes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  modo text not null,
  provider_customer_id text not null,
  created_at timestamptz not null default now(),
  constraint consulta_pagamento_clientes_modo_conhecido check (modo in ('teste', 'producao'))
);

create unique index if not exists consulta_pagamento_clientes_contato_uk
  on public.consulta_pagamento_clientes (organization_id, contact_id, modo);

alter table public.consulta_pagamento_clientes enable row level security;
revoke all on public.consulta_pagamento_clientes from anon, authenticated;
grant select, insert, update, delete on public.consulta_pagamento_clientes to service_role;

-- ── A cobrança de cada consulta ────────────────────────────────────────────
create table if not exists public.consulta_pagamentos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `set null`: o registro do dinheiro sobrevive ao compromisso.
  appointment_id uuid references public.calendar_appointments(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  modo text not null,
  provider_payment_id text not null,
  valor_cents integer not null,
  situacao text not null default 'pendente',
  link text,
  vencimento date,
  pago_em timestamptz,
  -- Verdadeiro quando ESTE pagamento confirmou a consulta.
  confirmou_consulta boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consulta_pagamentos_modo_conhecido check (modo in ('teste', 'producao')),
  constraint consulta_pagamentos_situacao_conhecida
    check (situacao in ('pendente', 'pago', 'vencido', 'cancelado', 'estornado')),
  constraint consulta_pagamentos_valor_positivo check (valor_cents > 0)
);

create unique index if not exists consulta_pagamentos_cobranca_uk
  on public.consulta_pagamentos (organization_id, provider_payment_id);

-- No máximo UMA cobrança viva por consulta: é o que impede cobrar duas vezes
-- quando a IA chama a ferramenta de novo, ou duas chamadas correm juntas.
create unique index if not exists consulta_pagamentos_uma_viva_por_consulta
  on public.consulta_pagamentos (organization_id, appointment_id)
  where situacao in ('pendente', 'pago');

create index if not exists consulta_pagamentos_contato_idx
  on public.consulta_pagamentos (organization_id, contact_id);

comment on table public.consulta_pagamentos is
  'Cobrança de consulta gerada no Asaas da organização. O dinheiro fica no Asaas; aqui mora o ponteiro e a situação relida da API. Server-side only.';

alter table public.consulta_pagamentos enable row level security;
revoke all on public.consulta_pagamentos from anon, authenticated;
grant select, insert, update, delete on public.consulta_pagamentos to service_role;

drop trigger if exists trg_consulta_pagamentos_updated_at on public.consulta_pagamentos;
create trigger trg_consulta_pagamentos_updated_at
  before update on public.consulta_pagamentos
  for each row execute function public.fn_set_updated_at();
