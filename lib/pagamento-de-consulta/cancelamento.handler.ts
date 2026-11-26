/**
 * Consulta cancelada (pela equipe, pela IA ou pela tela) → a cobrança PENDENTE
 * dela sai do Asaas da clínica, para o paciente não pagar por um horário que
 * voltou para a agenda. Cobrança já paga não é tocada: o estorno é decisão da
 * clínica, no Asaas.
 *
 * A expiração da reserva pelo cron não emite `appointment.cancelled` (o cron
 * muda o banco direto) e por isso chama `cancelarCobrancasDasConsultas` ele mesmo.
 *
 * `naOrgParada: "roda"`: tirar do ar uma cobrança de horário cancelado é o lado
 * seguro mesmo com a organização parada.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import { cancelarCobrancasDasConsultas } from "./producao";

export const CANCELAMENTO_DA_COBRANCA_HANDLER_KEY = "pagamento-de-consulta-cancelamento.v1";

export const cancelamentoDaCobrancaHandler: EventHandler = {
  key: CANCELAMENTO_DA_COBRANCA_HANDLER_KEY,
  naOrgParada: "roda",
  events: ["appointment.cancelled"],
  async handle(row): Promise<HandlerResult> {
    const base = { consumer_key: CANCELAMENTO_DA_COBRANCA_HANDLER_KEY };
    const bruto = row.payload.appointment_id ?? row.entity_id;
    if (typeof bruto !== "string" || bruto.trim() === "") return { ...base, status: "skipped", detail: "payload_incompleto" };
    // Só toca cobranças da MESMA organização do evento: a varredura filtra pela consulta,
    // e a consulta é desta org — a busca por organização garante o resto.
    const admin = createAdminClient();
    const { data } = await admin
      .from("calendar_appointments")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("id", bruto)
      .maybeSingle();
    if (!data) return { ...base, status: "skipped", detail: "agendamento_inexistente" };
    const n = await cancelarCobrancasDasConsultas(admin, [bruto]);
    return { ...base, status: n > 0 ? "ok" : "skipped", detail: `canceladas=${n}` };
  },
};
