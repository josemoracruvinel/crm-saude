/**
 * As dependências de produção de `./cobranca.ts`: banco (service role), Asaas
 * da clínica, Agenda e WhatsApp.
 *
 * ⚠️ Service role: TODA consulta filtra `organization_id` à mão. O id da org vem
 * do contexto do agente (ferramenta) ou da conexão dona do aviso (webhook), nunca
 * do corpo de quem chamou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { alterarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { camposCpfParaGravar } from "@/lib/contacts/cpf";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { agendaSettingsSchema } from "@/lib/schemas/settings";

import type { CobrarDeps, CobrancaGuardada, ConsultaDaCobranca, ProcessarDeps } from "./cobranca";
import { asaasDaOrganizacao } from "./conexao";

const COLUNAS_DA_COBRANCA = "id, provider_payment_id, appointment_id, situacao, link, valor_cents, vencimento, confirmou_consulta";

async function consulta(admin: SupabaseClient, orgId: string, appointmentId: string): Promise<ConsultaDaCobranca | null> {
  const { data, error } = await admin
    .from("calendar_appointments")
    .select("status, contact_id, conversation_id, event_type_id, starts_at, time_zone, title")
    .eq("organization_id", orgId)
    .eq("id", appointmentId)
    .maybeSingle();
  if (error) throw new Error(`calendar_appointments: ${error.message}`);
  return (data as ConsultaDaCobranca | null) ?? null;
}

async function cobrancaViva(admin: SupabaseClient, orgId: string, appointmentId: string): Promise<CobrancaGuardada | null> {
  const { data, error } = await admin
    .from("consulta_pagamentos")
    .select(COLUNAS_DA_COBRANCA)
    .eq("organization_id", orgId)
    .eq("appointment_id", appointmentId)
    .in("situacao", ["pendente", "pago"])
    .maybeSingle();
  if (error) throw new Error(`consulta_pagamentos: ${error.message}`);
  return (data as CobrancaGuardada | null) ?? null;
}

async function idiomaDaOrg(admin: SupabaseClient, orgId: string) {
  const { data } = await admin.from("organizations").select("locale").eq("id", orgId).maybeSingle();
  return normalizarIdioma((data as { locale?: string | null } | null)?.locale);
}

export function criarDepsDeCobrar(admin: SupabaseClient): CobrarDeps {
  return {
    conexao: (orgId) => asaasDaOrganizacao(admin, orgId),
    consulta: (orgId, id) => consulta(admin, orgId, id),

    async precoDoTipo(orgId, eventTypeId) {
      const { data, error } = await admin
        .from("calendar_event_types")
        .select("default_price_cents")
        .eq("organization_id", orgId)
        .eq("id", eventTypeId)
        .maybeSingle();
      if (error) throw new Error(`calendar_event_types: ${error.message}`);
      return (data as { default_price_cents: number | null } | null)?.default_price_cents ?? null;
    },

    cobrancaViva: (orgId, id) => cobrancaViva(admin, orgId, id),

    async clienteGuardado(orgId, contactId, modo) {
      const { data, error } = await admin
        .from("consulta_pagamento_clientes")
        .select("provider_customer_id")
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .eq("modo", modo)
        .maybeSingle();
      if (error) throw new Error(`consulta_pagamento_clientes: ${error.message}`);
      return (data as { provider_customer_id: string } | null)?.provider_customer_id ?? null;
    },

    async guardaCliente(orgId, contactId, modo, clienteId) {
      const { error } = await admin.from("consulta_pagamento_clientes").insert({
        organization_id: orgId,
        contact_id: contactId,
        modo,
        provider_customer_id: clienteId,
      });
      // 23505: outra chamada guardou o mesmo contato no meio — o Asaas devolveu o mesmo cliente pelo CPF.
      if (error && error.code !== "23505") throw new Error(`consulta_pagamento_clientes insert: ${error.message}`);
    },

    async nomeDoContato(orgId, contactId) {
      const { data } = await admin
        .from("contacts")
        .select("name, display_name")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      const c = data as { name: string | null; display_name: string | null } | null;
      return c?.name ?? c?.display_name ?? null;
    },

    async guardaCpfNaFicha(orgId, contactId, cpf) {
      try {
        const campos = await camposCpfParaGravar(admin, cpf);
        if (!campos.cpf_hash) return;
        await admin
          .from("contacts")
          .update(campos as never)
          .eq("organization_id", orgId)
          .eq("id", contactId)
          .is("cpf_hash", null);
      } catch (err) {
        // A ficha sem CPF não impede a cobrança: o Asaas já tem o documento.
        logger.warn("[pagamento-de-consulta] CPF não gravado na ficha", {
          organization_id: orgId,
          error: err instanceof Error ? err.name : "erro",
        });
      }
    },

    async prazoDaReservaMinutos(orgId) {
      const { data } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
      const s = (data as { settings?: { agenda?: unknown } | null } | null)?.settings?.agenda;
      return agendaSettingsSchema.parse(s ?? {}).pending_expires_after_minutes;
    },

    async insereCobranca(linha) {
      const { error } = await admin.from("consulta_pagamentos").insert(linha);
      if (!error) return true;
      if (error.code === "23505") return false;
      throw new Error(`consulta_pagamentos insert: ${error.message}`);
    },

    clock: () => new Date(),
  };
}

export function criarDepsDeProcessar(admin: SupabaseClient): ProcessarDeps {
  return {
    conexao: (orgId) => asaasDaOrganizacao(admin, orgId),

    async cobrancaPorId(orgId, providerPaymentId) {
      const { data, error } = await admin
        .from("consulta_pagamentos")
        .select(COLUNAS_DA_COBRANCA)
        .eq("organization_id", orgId)
        .eq("provider_payment_id", providerPaymentId)
        .maybeSingle();
      if (error) throw new Error(`consulta_pagamentos: ${error.message}`);
      return (data as CobrancaGuardada | null) ?? null;
    },

    async atualizaCobranca(orgId, id, lida, pagoEm) {
      const { error } = await admin
        .from("consulta_pagamentos")
        .update({
          situacao: lida.situacao,
          ...(lida.link ? { link: lida.link } : {}),
          ...(lida.vencimento ? { vencimento: lida.vencimento } : {}),
          ...(pagoEm ? { pago_em: pagoEm } : {}),
        })
        .eq("organization_id", orgId)
        .eq("id", id);
      if (error) throw new Error(`consulta_pagamentos update: ${error.message}`);
    },

    consulta: (orgId, id) => consulta(admin, orgId, id),

    async confirmaConsulta(orgId, appointmentId) {
      try {
        await alterarAgendamentoHandler(
          admin,
          {
            organization_id: orgId,
            actor: { type: "webhook_source", id: appointmentId },
            requestId: `pagamento-de-consulta:${appointmentId}`,
          },
          { id: appointmentId, status: "confirmed" },
        );
        return true;
      } catch (err) {
        // Cancelada no meio: não há o que confirmar. O resto sobe e o dreno tenta de novo.
        if (err instanceof ApiError && err.status === 422) return false;
        throw err;
      }
    },

    async marcaQueConfirmou(orgId, id) {
      const { data, error } = await admin
        .from("consulta_pagamentos")
        .update({ confirmou_consulta: true })
        .eq("organization_id", orgId)
        .eq("id", id)
        .eq("confirmou_consulta", false)
        .select("id");
      if (error) throw new Error(`consulta_pagamentos marca: ${error.message}`);
      return (data ?? []).length > 0;
    },

    async avisaPaciente(orgId, c) {
      if (!c.conversation_id) return;
      try {
        const idioma = await idiomaDaOrg(admin, orgId);
        const inicio = new Date(c.starts_at);
        const fuso = c.time_zone || "America/Sao_Paulo";
        const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, weekday: "long", day: "2-digit", month: "2-digit" }).format(inicio);
        const hora = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit" }).format(inicio);
        const corpo = traduzir("Pagamento recebido! Sua consulta de {dia} às {hora} está confirmada. Até lá!", idioma)
          .replace("{dia}", dia)
          .replace("{hora}", hora);
        await sendMessageHandler(
          admin,
          { organization_id: orgId, actor: { type: "webhook_source", id: c.conversation_id }, requestId: `pagamento-de-consulta:aviso:${c.conversation_id}` },
          { conversation_id: c.conversation_id, type: "text", body: corpo } as Parameters<typeof sendMessageHandler>[2],
        );
      } catch (err) {
        // A consulta já está confirmada; perder a mensagem é aceitável, repetir não.
        logger.warn("[pagamento-de-consulta] aviso ao paciente não enviado", {
          organization_id: orgId,
          error: err instanceof Error ? err.message.slice(0, 200) : "erro",
        });
      }
    },

    async avisaEquipe(orgId, appointmentId, motivo) {
      try {
        const idioma = await idiomaDaOrg(admin, orgId);
        const titulo = traduzir("Pagamento de consulta recebido sem horário reservado", idioma);
        const { data: jaAberto } = await admin
          .from("agent_inbox_items")
          .select("id")
          .eq("organization_id", orgId)
          .eq("kind", "other")
          .eq("ref_kind", "appointment")
          .eq("ref_id", appointmentId ?? "")
          .eq("status", "open")
          .eq("title", titulo)
          .limit(1)
          .maybeSingle();
        if (jaAberto) return;
        const { error } = await admin.from("agent_inbox_items").insert({
          organization_id: orgId,
          kind: "other",
          severity: "warn",
          title: titulo,
          body: traduzir(
            "O paciente pagou depois que a reserva do horário expirou ou foi cancelada. O dinheiro está na conta Asaas da clínica: remarque a consulta com ele ou faça o estorno pelo Asaas.",
            idioma,
          ),
          ref_kind: appointmentId ? "appointment" : null,
          ref_id: appointmentId,
        });
        if (error) throw new Error(error.message);
        logger.info("[pagamento-de-consulta] aviso à equipe aberto", { organization_id: orgId, motivo });
      } catch (err) {
        logger.warn("[pagamento-de-consulta] aviso à equipe não aberto", {
          organization_id: orgId,
          error: err instanceof Error ? err.message.slice(0, 200) : "erro",
        });
      }
    },

    clock: () => new Date(),
  };
}

/**
 * A reserva expirou ou foi cancelada: a cobrança pendente sai do Asaas, para o
 * paciente não pagar por um horário que voltou para a agenda. Melhor esforço,
 * nunca lança — o que ficar para trás, o aviso de pagamento tardio cobre.
 */
export async function cancelarCobrancasDasConsultas(admin: SupabaseClient, appointmentIds: string[]): Promise<number> {
  if (appointmentIds.length === 0) return 0;
  let canceladas = 0;
  try {
    const { data, error } = await admin
      .from("consulta_pagamentos")
      .select("id, organization_id, provider_payment_id")
      .in("appointment_id", appointmentIds)
      .eq("situacao", "pendente");
    if (error) throw new Error(error.message);
    for (const c of (data ?? []) as { id: string; organization_id: string; provider_payment_id: string }[]) {
      try {
        const conexao = await asaasDaOrganizacao(admin, c.organization_id);
        if (conexao) await conexao.asaas.cancelarCobranca(c.provider_payment_id);
        await admin
          .from("consulta_pagamentos")
          .update({ situacao: "cancelado" })
          .eq("organization_id", c.organization_id)
          .eq("id", c.id)
          .eq("situacao", "pendente");
        canceladas += 1;
      } catch (err) {
        logger.warn("[pagamento-de-consulta] cobrança não cancelada", {
          organization_id: c.organization_id,
          error: err instanceof Error ? err.name : "erro",
        });
      }
    }
  } catch (err) {
    logger.warn("[pagamento-de-consulta] varredura de cobranças falhou", {
      error: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
  }
  return canceladas;
}
