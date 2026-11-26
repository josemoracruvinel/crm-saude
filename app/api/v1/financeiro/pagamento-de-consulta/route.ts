import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * A CONTA ASAAS DA CLÍNICA para cobrar consultas (Configurações › Financeiro,
 * cartão "Pagamento de consultas"). Desenho:
 * docs/superpowers/specs/2026-11-26-cobranca-da-consulta-asaas-design.md
 *
 *   GET    — estado: conectada?, 4 últimos caracteres, teste ou produção, aviso
 *            cadastrado?. Nunca a chave.
 *   PUT    — conecta ou troca a conta: testa a chave, grava cifrada e cadastra o
 *            aviso de pagamento no Asaas. Admin.
 *   DELETE — desconecta: remove o aviso no Asaas e a conexão. Admin.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  chaveDoAsaasSchema,
  conectarAsaas,
  desconectarAsaas,
  estadoDaConexao,
  type EstadoDaConexao,
} from "@/lib/pagamento-de-consulta/conexao";
import { createAdminClient } from "@/lib/supabase/admin";

const putSchema = z.object({ api_key: chaveDoAsaasSchema }).strict();

function corpoDoEstado(e: EstadoDaConexao) {
  return {
    provider: "asaas",
    conectada: e.conectada,
    ultimos4: e.ultimos4,
    modo: e.modo,
    aviso_cadastrado: e.avisoCadastrado,
    atualizada_em: e.atualizadaEm,
  };
}

/** Cada recusa em frase de gente, e o que fazer. */
const FRASE_DO_ERRO: Record<string, string> = {
  chave_invalida: "O Asaas recusou a chave. Confira se copiou a chave inteira, começando por $aact_.",
  sem_permissao: "A chave não tem permissão para criar cobranças. Gere uma chave nova no Asaas, em Integrações.",
  provedor_fora: "Não consegui falar com o Asaas agora. Tente de novo em instantes.",
  cifra_indisponivel: "A cifra do servidor não está disponível; a chave não foi gravada.",
  sem_url_publica: "Este servidor não tem endereço https público, e o Asaas não consegue avisar os pagamentos.",
  aviso_recusado:
    "A chave foi gravada, mas o Asaas recusou o cadastro do aviso de pagamento. Confira o e-mail da sua conta e tente conectar de novo.",
  erro_ao_gravar: "Não consegui gravar a conexão.",
};

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "consulta_pagamento" });
  if (!authz.ok) return authz.response;
  try {
    return ok(corpoDoEstado(await estadoDaConexao(createAdminClient(), authz.org.orgId)), { requestId });
  } catch {
    return fail("internal_error", traduzir("Não consegui ler a conexão com o Asaas.", authz.user.idioma), 500, { requestId });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "consulta_pagamento" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = putSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Essa não parece uma chave do Asaas: ela começa com $aact_prod_ ou $aact_hmlg_."), 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const r = await conectarAsaas(admin, {
    organizationId: authz.org.orgId,
    chave: parsed.data.api_key,
    atorId: authz.user.id,
    emailDoAtor: authz.user.email,
    baseUrl: env.NEXT_PUBLIC_APP_URL ?? "",
  });
  if (!r.ok) {
    const status = r.erro === "provedor_fora" ? 503 : r.erro === "cifra_indisponivel" || r.erro === "erro_ao_gravar" ? 500 : 422;
    return fail(status === 422 ? "validation_failed" : status === 503 ? "unavailable" : "internal_error", t(FRASE_DO_ERRO[r.erro] ?? "Não consegui conectar."), status, {
      requestId,
    });
  }

  await audit({
    action: "consulta_pagamento.conectado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "consulta_pagamento_conexao",
    resourceId: null,
    requestId,
    // O QUE mudou, jamais o valor.
    metadata: { provider: "asaas", last4: r.estado.ultimos4, modo: r.estado.modo, trocou: r.trocou },
  });
  return ok(corpoDoEstado(r.estado), { requestId });
}

export async function DELETE(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "consulta_pagamento" });
  if (!authz.ok) return authz.response;

  let removeu: boolean;
  try {
    removeu = await desconectarAsaas(createAdminClient(), authz.org.orgId);
  } catch {
    return fail("internal_error", traduzir("Não consegui desconectar o Asaas.", authz.user.idioma), 500, { requestId });
  }
  if (removeu) {
    await audit({
      action: "consulta_pagamento.desconectado",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "consulta_pagamento_conexao",
      resourceId: null,
      requestId,
      metadata: { provider: "asaas" },
    });
  }
  return ok({ provider: "asaas", conectada: false, removida: removeu }, { requestId });
}
