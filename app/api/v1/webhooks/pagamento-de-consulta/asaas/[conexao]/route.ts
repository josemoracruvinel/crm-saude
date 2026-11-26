/**
 * POST /api/v1/webhooks/pagamento-de-consulta/asaas/[conexao] — o aviso de
 * pagamento da conta Asaas DA CLÍNICA (desenho:
 * docs/superpowers/specs/2026-11-26-cobranca-da-consulta-asaas-design.md).
 *
 * O aviso só ACORDA a leitura, como na cobrança do revendedor: a rota confere o
 * token (`asaas-access-token`, comparado pelo hash gravado na conexão), tira do
 * corpo só o id da cobrança e emite `consulta_pagamento.sinal`. Quem decide é o
 * consumidor, que RELÊ a cobrança na API do Asaas — o corpo nunca é levado em
 * conta. Aviso repetido é inofensivo: o consumidor é idempotente.
 *
 * A organização vem da CONEXÃO do caminho, nunca do corpo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { EVENTOS_DO_AVISO_DE_PAGAMENTO } from "@/lib/pagamento-de-consulta/asaas";
import { conexaoDoAviso, tokenConfere } from "@/lib/pagamento-de-consulta/conexao";
import { EVENTO_DO_SINAL_DE_PAGAMENTO } from "@/lib/pagamento-de-consulta/sinal.handler";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const LIMITE_DO_CORPO = 262_144;
const RECUSAS_POR_MINUTO = 60;

const avisoDoAsaas = z.object({
  id: z.string().min(1).max(100),
  event: z.string().regex(/^[A-Z_]{1,64}$/),
  payment: z.object({ id: z.string().min(1).max(100) }).nullish(),
});

type Rota = { params: Promise<{ conexao: string }> };

export async function POST(req: NextRequest, { params }: Rota) {
  const requestId = randomUUID();
  const { conexao: conexaoId } = await params;
  const admin = createAdminClient();

  let conexao: Awaited<ReturnType<typeof conexaoDoAviso>>;
  try {
    conexao = await conexaoDoAviso(admin, conexaoId);
  } catch {
    return fail("unavailable", "Tente de novo em instantes.", 503, { requestId });
  }
  if (!conexao) return fail("not_found", "Not found", 404, { requestId });

  if (Number(req.headers.get("content-length") ?? "0") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }
  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > LIMITE_DO_CORPO) {
    return fail("payload_too_large", "Aviso grande demais.", 413, { requestId });
  }

  if (!tokenConfere(req.headers.get("asaas-access-token"), conexao.tokenHash)) {
    // Só RECUSAS contam no limite: aviso válido nunca leva 429.
    const balde = ipDoCliente(req.headers) ?? "sem-proxy";
    const taxa = await checkRateLimit(`pagamento-de-consulta-recusado:${balde}`, RECUSAS_POR_MINUTO, 60);
    if (!taxa.allowed) {
      return fail("rate_limited", "Muitos avisos recusados seguidos.", 429, { requestId, headers: { "Retry-After": "60" } });
    }
    logger.warn("pagamento_de_consulta.aviso_recusado", { organization_id: conexao.organizationId });
    return fail("unauthorized", "Token inválido.", 401, { requestId });
  }

  let json: unknown = null;
  try {
    json = JSON.parse(corpo);
  } catch {
    // forma inesperada: cai no ramo de baixo
  }
  const aviso = avisoDoAsaas.safeParse(json);
  // Token CERTO e forma ou evento que não interessa: é o Asaas. 200 sem efeito —
  // recusar faria o Asaas pausar a fila e travar os avisos verdadeiros.
  if (
    !aviso.success ||
    !aviso.data.payment?.id ||
    !(EVENTOS_DO_AVISO_DE_PAGAMENTO as readonly string[]).includes(aviso.data.event)
  ) {
    return ok({ ignorado: true }, { requestId });
  }

  const { error } = await admin.rpc("emit_event", {
    p_event_type: EVENTO_DO_SINAL_DE_PAGAMENTO,
    p_entity_kind: "organization",
    p_entity_id: conexao.organizationId,
    p_payload: { provider_payment_id: aviso.data.payment.id, tipo: aviso.data.event, evento_id: aviso.data.id },
    p_metadata: { origem: "webhook_pagamento_de_consulta" },
    p_organization_id: conexao.organizationId,
  });
  if (error) {
    logger.error("pagamento_de_consulta.sinal_nao_emitido", { organization_id: conexao.organizationId, codigo: error.code ?? null });
    return fail("unavailable", "Tente de novo em instantes.", 503, { requestId });
  }
  return ok({ recebido: true }, { requestId });
}
