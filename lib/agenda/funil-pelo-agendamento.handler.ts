/**
 * Adapter fino que pluga `aplicaFunilPeloAgendamento` (`./funil-pelo-agendamento.ts`)
 * no dispatcher do `event_log`: a regra fica pura e testável, aqui só há a
 * ligação com o registry e o client de produção.
 *
 * `naOrgParada: "roda"` — é escrita interna no próprio banco, sem rede de
 * terceiro, como o aviso de etapa e a comanda do ganho.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  EVENTOS_DO_FUNIL_PELO_AGENDAMENTO,
  FUNIL_PELO_AGENDAMENTO_HANDLER_KEY,
  aplicaFunilPeloAgendamento,
  criarDepsDoFunilPeloAgendamento,
} from "./funil-pelo-agendamento";

export const funilPeloAgendamentoHandler: EventHandler = {
  key: FUNIL_PELO_AGENDAMENTO_HANDLER_KEY,
  naOrgParada: "roda",
  events: [...EVENTOS_DO_FUNIL_PELO_AGENDAMENTO],
  async handle(row): Promise<HandlerResult> {
    try {
      return await aplicaFunilPeloAgendamento(criarDepsDoFunilPeloAgendamento(createAdminClient()), row);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FUNIL_PELO_AGENDAMENTO_HANDLER_KEY, status: "error", detail };
    }
  },
};
