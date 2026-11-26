/**
 * O FUNIL ANDA COM A AGENDA — marcar e confirmar um horário avançam o atendimento.
 *
 * Medido em 25/11/2026: a IA marcou a consulta (a Agenda mostrou "Confirmado"),
 * mas o card do cliente ficou parado em "Triagem". O card só andava quando o
 * modelo chamava `update_lead_state`, e ele não chamava — ninguém ligava o fato
 * "tem horário marcado" ao funil. Agora o fato liga:
 *
 *   horário RESERVADO (nasce `pending`, o tipo exige confirmação) → passo `negotiating`
 *   horário CONFIRMADO (nasce `confirmed`, ou `pending → confirmed`)  → passo `won`
 *
 * O passo é o do AGENTE (`lead_state`), e o card acompanha pela MESMA ponte que o
 * agente usa (`sincronizaEstagioDoAgente`, que lê `crm_stages.agent_stage_hint`).
 * Mover só o card deixaria o `lead_state` para trás, e o próximo
 * `update_lead_state` do agente puxaria o card de volta para uma etapa anterior.
 *
 * ⚠️ SÓ AVANÇA, NUNCA RECUA. O avanço percorre a máquina de estados passo a passo
 * (`LEAD_STAGE_TRANSITIONS`) e grava uma linha de histórico por passo; quem já
 * está no passo de destino, depois dele, ou num terminal (`won`/`lost`) não muda.
 * Cancelamento não desfaz nada aqui: decidir o que um cancelamento significa no
 * funil é do dono, não deste arquivo.
 *
 * ⚠️ A SITUAÇÃO É LIDA DO BANCO, não do evento: entre emitir e drenar o horário
 * pode ter sido confirmado (vale o `won`) ou cancelado (não vale nada).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { LEAD_STAGE_TRANSITIONS, type LeadStage } from "@/lib/agent-engine/agent/lead-state";
import { sincronizaEstagioDoAgente, type ResultadoDaSincronizacao } from "@/lib/leads/agent-stage-sync";
import { logger } from "@/lib/logger";

export const FUNIL_PELO_AGENDAMENTO_HANDLER_KEY = "agenda-funil-pelo-agendamento.v1";

export const EVENTOS_DO_FUNIL_PELO_AGENDAMENTO = ["appointment.created", "appointment.confirmed"] as const;

/** Espera quando outro escritor mexeu no `lead_state` entre a leitura e a escrita. */
const REPETIR_EM_MS = 30_000;

/** O passo do atendimento que o horário representa, ou `null` quando não é notícia para o funil. */
export function passoDoAgendamento(evento: string, situacao: string): LeadStage | null {
  if (evento !== "appointment.created" && evento !== "appointment.confirmed") return null;
  if (situacao === "confirmed") return "won";
  if (situacao === "pending" && evento === "appointment.created") return "negotiating";
  return null;
}

/**
 * Os passos de `atual` até `alvo`, um por um, pela máquina de estados.
 * Vazio quando não há avanço: já está lá, já passou, ou está num terminal.
 */
export function caminhoAte(atual: LeadStage, alvo: LeadStage): LeadStage[] {
  const caminho: LeadStage[] = [];
  let passo = atual;
  while (passo !== alvo) {
    // O avanço "para a frente" é o primeiro da lista; o outro é sempre `lost`.
    const proximo = LEAD_STAGE_TRANSITIONS[passo].find((s) => s !== "lost");
    if (!proximo) return [];
    caminho.push(proximo);
    passo = proximo;
  }
  return caminho;
}

export interface AgendamentoDoFunil {
  status: string;
  contact_id: string | null;
}

export interface FunilPeloAgendamentoDeps {
  carregaAgendamento(orgId: string, appointmentId: string): Promise<AgendamentoDoFunil | null>;
  /** `null` = o contato ainda não tem `lead_state` (o agente nunca o atendeu). */
  passoAtual(orgId: string, contactId: string): Promise<LeadStage | null>;
  /**
   * Grava o novo passo SÓ se o atual ainda é `de` (trava otimista) e anexa o
   * histórico. `false` = outro escritor mudou o estado no meio.
   */
  avanca(orgId: string, contactId: string, de: LeadStage | null, caminho: LeadStage[], motivo: string): Promise<boolean>;
  moveCard(orgId: string, contactId: string, passo: LeadStage): Promise<ResultadoDaSincronizacao>;
  clock(): Date;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** O espelho que não andou por defeito (banco fora, escrita recusada) é o único `error`. */
const MOTIVOS_DE_INCIDENTE = new Set<ResultadoDaSincronizacao["motivo"]>(["indisponivel", "falha_de_escrita"]);

export async function aplicaFunilPeloAgendamento(
  deps: FunilPeloAgendamentoDeps,
  row: EventRow,
): Promise<HandlerResult> {
  const base = { consumer_key: FUNIL_PELO_AGENDAMENTO_HANDLER_KEY };
  const pulou = (detail: string): HandlerResult => ({ ...base, status: "skipped", detail });

  const orgId = row.organization_id;
  const appointmentId = texto(row.payload.appointment_id) ?? texto(row.entity_id);
  if (!appointmentId) return pulou("payload_incompleto");

  const agendamento = await deps.carregaAgendamento(orgId, appointmentId);
  if (!agendamento) return pulou("agendamento_inexistente");
  if (!agendamento.contact_id) return pulou("sem_contato");

  const alvo = passoDoAgendamento(row.event_type, agendamento.status);
  if (!alvo) return pulou(`agendamento_${agendamento.status}`);

  const contactId = agendamento.contact_id;
  const atual = await deps.passoAtual(orgId, contactId);
  const caminho = caminhoAte(atual ?? "new", alvo);

  // Já está no destino: o estado está certo, mas o card pode não ter andado
  // (retentativa depois de banco fora). Mover de novo é idempotente.
  if (caminho.length === 0 && atual !== alvo) return pulou(`ja_avancado:${atual ?? "new"}`);

  if (caminho.length > 0) {
    const motivo = alvo === "won" ? "horário confirmado na agenda" : "horário reservado na agenda";
    const gravou = await deps.avanca(orgId, contactId, atual, caminho, motivo);
    if (!gravou) {
      return {
        ...base,
        status: "retry",
        retry_at: new Date(deps.clock().getTime() + REPETIR_EM_MS).toISOString(),
        detail: "estado_mudou_no_meio",
      };
    }
  }

  const card = await deps.moveCard(orgId, contactId, alvo);
  const detail = `passo=${alvo}:card=${card.motivo}${card.stageName ? `:${card.stageName}` : ""}`;
  return { ...base, status: MOTIVOS_DE_INCIDENTE.has(card.motivo) ? "error" : "ok", detail };
}

/* ── Produção ─────────────────────────────────────────────────────────────── */

export function criarDepsDoFunilPeloAgendamento(admin: SupabaseClient): FunilPeloAgendamentoDeps {
  return {
    async carregaAgendamento(orgId, appointmentId) {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select("status, contact_id")
        .eq("organization_id", orgId)
        .eq("id", appointmentId)
        .maybeSingle();
      if (error) throw new Error(`calendar_appointments: ${error.message}`);
      return (data as AgendamentoDoFunil | null) ?? null;
    },

    async passoAtual(orgId, contactId) {
      const { data, error } = await admin
        .from("lead_state")
        .select("stage")
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .maybeSingle();
      if (error) throw new Error(`lead_state: ${error.message}`);
      return ((data as { stage: LeadStage } | null)?.stage ?? null) as LeadStage | null;
    },

    async avanca(orgId, contactId, de, caminho, motivo) {
      const alvo = caminho[caminho.length - 1]!;
      if (de === null) {
        const { error } = await admin
          .from("lead_state")
          .insert({ organization_id: orgId, contact_id: contactId, stage: alvo });
        if (error) {
          // O agente criou o estado no meio: lê de novo na próxima volta.
          if (error.code === "23505") return false;
          throw new Error(`lead_state insert: ${error.message}`);
        }
      } else {
        const { data, error } = await admin
          .from("lead_state")
          .update({ stage: alvo, updated_at: new Date().toISOString() })
          .eq("organization_id", orgId)
          .eq("contact_id", contactId)
          .eq("stage", de)
          .select("id");
        if (error) throw new Error(`lead_state update: ${error.message}`);
        if ((data ?? []).length === 0) return false;
      }

      // Uma linha por passo, como o agente grava: o histórico nunca mostra salto.
      let anterior: LeadStage = de ?? "new";
      const linhas = caminho.map((para) => {
        const linha = { organization_id: orgId, contact_id: contactId, from_stage: anterior, to_stage: para, reason: motivo };
        anterior = para;
        return linha;
      });
      const { error: erroHistorico } = await admin.from("lead_state_transitions").insert(linhas);
      // O estado já mudou e é a fonte da verdade; histórico perdido não desfaz o avanço.
      if (erroHistorico) {
        logger.error("[agenda-funil] histórico de transição não gravado", {
          organization_id: orgId,
          error: erroHistorico.message,
        });
      }
      return true;
    },

    moveCard(orgId, contactId, passo) {
      return sincronizaEstagioDoAgente(admin, { organizationId: orgId, contactId, passo });
    },

    clock: () => new Date(),
  };
}
