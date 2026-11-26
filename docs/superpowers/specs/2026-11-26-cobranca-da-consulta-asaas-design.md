# Cobrança da consulta pelo Asaas — desenho

> Status: **aprovado** (26/11/2026), com as 4 recomendações da §8. Implementado na 1.105.0, menos
> o item 7 da §4.
> Versão alvo: **1.105.0**.

## 1. O que queremos, em uma frase

A atendente de IA marca a consulta, **gera a cobrança no Asaas da própria clínica e manda o link
ao paciente**; quando o pagamento cai, **a consulta se confirma sozinha** e o cartão do funil vai
para "Consulta agendada", sem ninguém clicar.

Serve para médicos, psicólogos e qualquer profissional que só confirma o horário depois do
pagamento.

## 2. Como fica para cada pessoa

**Paciente (no WhatsApp)**
1. Conversa com a Tereza, escolhe o horário, informa nome, data de nascimento e CPF.
2. Recebe: "Seu horário ficou reservado. Para confirmar, é só pagar por este link: …"
   O link abre a página do Asaas, onde ele escolhe Pix ou cartão.
3. Paga. Em instantes recebe: "Pagamento recebido! Sua consulta de quinta, 14h, está confirmada."

**Clínica (no AlôClin)**
1. Uma vez só: em **Configurações › Financeiro**, cartão "Pagamento de consultas (Asaas)", cola a
   chave da conta Asaas dela e clica em "Conectar". O sistema testa a chave e cadastra sozinho o
   aviso de pagamento no Asaas.
2. Liga "Exigir confirmação humana" e preenche o **preço** no tipo de consulta (já existem).
3. Liga a capacidade "Cobrar a consulta" no agente (ela é marcada uma a uma: o pacote "Vender" não
   a liga sozinho).
4. No dia a dia, vê a consulta passar de "aguardando confirmação" para "confirmada" sozinha e o
   cartão andando no funil. (Selos de pagamento na Agenda: versão seguinte, ver §4 item 7.)

**Dinheiro:** cai direto na conta Asaas da clínica. O AlôClin nunca toca no dinheiro.

## 3. O que já existe e será reaproveitado

| Peça | Onde | Uso aqui |
|---|---|---|
| Conversa com o Asaas (criar cliente, cobrança, webhook, testar chave) | `lib/cobranca/provedores/asaas.ts` | Base do novo adaptador. Hoje serve à cobrança das clínicas pela plataforma (uma conta só). |
| Chave por organização cifrada no banco | padrão de `map_provider_credentials` (`fn_encrypt_oauth`) | Guardar a chave Asaas de cada clínica; ela nunca volta para a tela. |
| Consulta "reservada" que ocupa a vaga | `requires_confirmation` → `pending` | O horário fica preso enquanto o paciente paga. |
| Reserva que ninguém decide expira | cron `agenda-expira-pendentes` (prazo por clínica, padrão 24 h) | Se não pagar no prazo, a vaga volta. |
| Preço do tipo de consulta | `calendar_event_types.default_price_cents` | Valor da cobrança. |
| Cartão anda ao confirmar | 1.104.3 (`appointment.confirmed`) | Nada novo a fazer. |

## 4. As peças novas

1. **Conexão Asaas da clínica** — tabela nova `consulta_pagamento_conexoes` (uma por organização):
   chave cifrada, últimos 4 dígitos, modo (teste ou produção, pelo prefixo da chave), id do
   webhook no Asaas e o **hash** do token do webhook. Tela em Configurações para conectar,
   testar e desconectar. Só administrador da clínica mexe.
2. **Cobranças** — tabela nova `consulta_pagamentos`: organização, consulta, contato, id da
   cobrança no Asaas (único), valor em centavos, situação (`pendente`, `pago`, `vencido`,
   `cancelado`, `estornado`), link, vencimento, data do pagamento.
3. **Ferramenta da IA "Cobrar a consulta"** (`crm_charge_appointment`) — recebe a consulta e o
   CPF; cria (ou reaproveita) o cliente no Asaas, cria a cobrança com o preço do tipo, Pix ou
   cartão à escolha do paciente, e devolve o link. Repetir a chamada para a mesma consulta
   devolve **o mesmo link** (nunca cobra duas vezes). Fica desligada até a clínica ligar.
4. **Aviso de pagamento** — rota nova `/api/v1/webhooks/pagamento-de-consulta/asaas/[conexao]`.
   Confere o token, grava o aviso e **relê a cobrança na API do Asaas** (o corpo do aviso nunca é
   levado em conta). Se pago e a consulta ainda está reservada: confirma a consulta, o que dispara
   o cartão para "Consulta agendada".
5. **Mensagem de confirmação ao paciente** quando o pagamento cai (texto padrão, editável).
6. **Prazo** — quando a reserva expira sem pagamento, a cobrança é **cancelada no Asaas** para o
   paciente não pagar por um horário que já voltou para a agenda.
7. **Selos na Agenda** e linha na linha do tempo do contato ("Cobrança gerada", "Pagamento recebido").
   ⚠️ **Fora da 1.105.0** (fica para a versão seguinte). Na 1.105.0 a clínica vê o efeito — a
   consulta passa de "aguardando confirmação" para "confirmada" sozinha, o cartão anda, e o
   pagamento tardio abre aviso na Central —, e a situação de cada cobrança fica no painel do Asaas.

## 5. Casos difíceis, e o que acontece

| Caso | O que o sistema faz |
|---|---|
| Paciente paga depois que a reserva expirou | Registra o pagamento, **não** confirma consulta nenhuma e abre aviso na Central para a equipe remarcar ou estornar. |
| Aviso do Asaas chega duas vezes | O segundo é ignorado (mesmo id). |
| Aviso falso (sem o token certo) | Recusado e registrado. |
| Clínica sem conexão Asaas ou tipo sem preço | A ferramenta responde que não dá para cobrar, e a IA volta ao texto antigo ("a equipe envia o link"). |
| Equipe confirma à mão antes do pagamento | Vale a decisão da equipe; o pagamento que chegar depois só registra. |
| Consulta cancelada com pagamento feito | Aviso na Central; o estorno é feito pela clínica no Asaas (primeira versão). |
| Chave de teste do Asaas | Tudo funciona no ambiente de teste, sem dinheiro de verdade. É assim que vamos provar. |

## 6. Segurança e LGPD

- A chave Asaas é digitada **pela clínica** na tela, guardada cifrada, nunca aparece de novo nem
  em log. A IA nunca vê a chave.
- O CPF é pedido **só** para a cobrança, vai ao Asaas e fica guardado **cifrado** na ficha do
  contato (o campo já existe: `contacts.cpf_encrypted` + `cpf_hash`). Na segunda consulta do mesmo
  paciente, a IA não precisa pedir de novo. A instrução da IA explica ao paciente por que pede.
- Toda ação grava auditoria (`consulta_pagamento.conectado`, `.cobranca_gerada`, `.pago`).
- Cada clínica só enxerga as próprias cobranças (regras de isolamento do banco).

## 7. Fora da primeira versão

Estorno pelo AlôClin, desconto, parcelamento escolhido pela clínica, lançamento automático na
comanda do financeiro, outros provedores (Mercado Pago, Stripe). Ficam anotados.

## 8. Decisões que preciso de você

1. **CPF:** a Tereza pede o CPF na conversa (recomendado: o Asaas exige CPF do pagador para
   emitir a cobrança, e assim o link já sai pronto).
2. **Prazo para pagar:** usar o prazo de reserva da clínica, que hoje é 24 h e pode ser mudado
   em Agenda › Regras gerais (recomendado).
3. **Formas de pagamento:** Pix e cartão, o paciente escolhe na página do Asaas (recomendado).
4. **Mensagem automática** de "pagamento recebido, consulta confirmada" ao paciente: ligada
   (recomendado).

## 9. Como vamos provar antes de publicar

1. Testes automáticos de cada regra (cobrança única por consulta, aviso falso recusado, pago
   depois do prazo, etc.).
2. Typecheck, lint e os testes ligados à mudança, como na 1.104.3.
3. **Teste real no ambiente de teste do Asaas:** você cria uma conta de teste
   (sandbox.asaas.com), cola a chave na tela da clínica de demonstração, e fazemos uma conversa
   de verdade com a Tereza até o pagamento simulado confirmar a consulta e mover o cartão.
4. Só então publicamos a 1.105.0, com seu OK em cada etapa.

## 10. Notas técnicas (para quem programa)

- Destino: **núcleo, desligado por padrão** — sem conexão Asaas nada muda para ninguém.
- Migration nova + apêndice idempotente no `baseline.sql`; funções novas com `revoke` de
  `public` e `anon`; RLS com `fn_user_org_ids()` nas duas tabelas.
- Adaptador separado do da cobrança do revendedor (outra conta, outra chave, outro webhook),
  reaproveitando `chamar`, `verificarWebhookAsaas`, `erroDoAsaas` e as regras de nova tentativa.
- Confirmação pelo caminho existente (`alterarAgendamentoHandler`, ator `webhook_source`), para
  emitir `appointment.confirmed` e não duplicar regra.
- Ferramenta nova registrada no catálogo de capacidades, em `escopo-das-escritas.ts` e
  `escopo-de-funil.ts`, com os testes de completude.
- `pnpm test:db` não roda neste Windows; os invariantes de banco serão validados aplicando o
  baseline num Postgres descartável, se disponível, ou ficam declarados como não provados.
