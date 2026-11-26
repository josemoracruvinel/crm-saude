/**
 * O consumidor de `consulta_pagamento.sinal` — o aviso de pagamento da conta
 * Asaas da clínica, emitido pela rota
 * `app/api/v1/webhooks/pagamento-de-consulta/asaas/[conexao]`.
 *
 * Adapter fino: a regra é `processarPagamento` (`./cobranca.ts`), que relê a
 * cobrança na API e, se pagou e a consulta ainda está reservada, confirma.
 *
 * `naOrgParada: "roda"` — o dinheiro já está na conta da clínica; registrar e
 * confirmar é escrita no próprio banco. A mensagem ao paciente passa pelo
 * `sendMessageHandler`, que já recusa envio de organização parada.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";
import { createAdminClient } from "@/lib/supabase/admin";

import { processarPagamento } from "./cobranca";
import { criarDepsDeProcessar } from "./producao";

export const EVENTO_DO_SINAL_DE_PAGAMENTO = "consulta_pagamento.sinal";
export const SINAL_DE_PAGAMENTO_HANDLER_KEY = "pagamento-de-consulta-sinal.v1";

const REPETIR_EM_MS = 60_000;

export const sinalDePagamentoHandler: EventHandler = {
  key: SINAL_DE_PAGAMENTO_HANDLER_KEY,
  naOrgParada: "roda",
  events: [EVENTO_DO_SINAL_DE_PAGAMENTO],
  async handle(row): Promise<HandlerResult> {
    const base = { consumer_key: SINAL_DE_PAGAMENTO_HANDLER_KEY };
    const id = row.payload.provider_payment_id;
    if (typeof id !== "string" || id.trim() === "") return { ...base, status: "skipped", detail: "payload_incompleto" };
    try {
      const desfecho = await processarPagamento(criarDepsDeProcessar(createAdminClient()), {
        organizationId: row.organization_id,
        providerPaymentId: id,
      });
      return { ...base, status: desfecho === "sem_conexao" || desfecho === "cobranca_desconhecida" ? "skipped" : "ok", detail: desfecho };
    } catch (err) {
      // Asaas fora do ar ou limite: tenta de novo depois, sem perder o aviso.
      if (err instanceof ErroDoProvedor && err.transitorio) {
        return { ...base, status: "retry", retry_at: new Date(Date.now() + REPETIR_EM_MS).toISOString(), detail: err.codigo };
      }
      const detail = err instanceof ErroDoProvedor ? `asaas:${err.codigo}` : err instanceof Error ? err.message.slice(0, 200) : String(err);
      return { ...base, status: "error", detail };
    }
  },
};
