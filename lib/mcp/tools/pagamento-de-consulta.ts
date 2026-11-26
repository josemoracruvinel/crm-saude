/**
 * A ferramenta "Cobrar a consulta" — gera (ou devolve) o link de pagamento da
 * consulta no Asaas DA CLÍNICA. Desenho:
 * docs/superpowers/specs/2026-11-26-cobranca-da-consulta-asaas-design.md
 *
 * A regra mora em `lib/pagamento-de-consulta/cobranca.ts` (`cobrarConsulta`); aqui
 * só a ponte com o turno do agente. As tabelas são server-side only, então a
 * leitura usa o admin client com `organization_id` do TURNO (`ctx.organizationId`),
 * nunca do input.
 *
 * Nada de falha derruba a conversa: todo motivo volta ao modelo como frase do
 * que fazer, e o Asaas fora do ar vira "a equipe envia o link".
 */
import { z } from "zod";

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";
import { logger } from "@/lib/logger";
import type { McpToolDefinition } from "@/lib/mcp/types";
import { cobrarConsulta, type ResultadoDaCobranca } from "@/lib/pagamento-de-consulta/cobranca";
import { criarDepsDeCobrar } from "@/lib/pagamento-de-consulta/producao";
import { createAdminClient } from "@/lib/supabase/admin";

/** O que o modelo deve FAZER em cada recusa — em frase, não em código. */
const ENSINO: Record<Extract<ResultadoDaCobranca, { ok: false }>["motivo"] | "asaas_fora", string> = {
  sem_conexao:
    "esta clínica não cobra pelo atendimento automático. Diga que o horário ficou reservado e que a equipe envia o link de pagamento.",
  consulta_inexistente: "não achei esta consulta. Confira a consulta marcada nesta conversa antes de cobrar.",
  consulta_cancelada: "esta consulta foi cancelada ou já aconteceu: não há o que cobrar. Ofereça marcar de novo.",
  sem_contato: "esta consulta não está ligada a um paciente. Diga que a equipe envia o link de pagamento.",
  sem_preco:
    "o tipo de consulta não tem preço cadastrado. Diga que a equipe envia o link de pagamento; não invente valor.",
  cpf_necessario:
    "para emitir a cobrança preciso do CPF do paciente (é exigência do emissor do pagamento). Peça o CPF, explique que é só para a cobrança, e chame de novo com ele.",
  cpf_invalido: "o CPF informado não é válido. Peça para a pessoa conferir os números e chame de novo.",
  sem_link: "a cobrança não ficou pronta agora. Diga que a equipe envia o link de pagamento em seguida.",
  asaas_fora:
    "o sistema de pagamento não respondeu agora. Diga que o horário ficou reservado e que a equipe envia o link de pagamento.",
};

const cobrarShape = {
  appointment_id: z.string().uuid().describe("a consulta reservada nesta conversa"),
  cpf: z
    .string()
    .max(20)
    .optional()
    .describe("CPF do paciente que vai pagar, só os números. Necessário só na primeira cobrança deste paciente."),
};

export const crmChargeAppointment: McpToolDefinition<typeof cobrarShape> = {
  name: "crm_charge_appointment",
  description:
    "Gera o link de pagamento da consulta (Pix ou cartão, o paciente escolhe na página) e devolve o link para você ENVIAR ao paciente. " +
    "Use logo depois de reservar o horário, quando a clínica confirma a consulta só após o pagamento. " +
    "Chamar de novo para a mesma consulta devolve o MESMO link: nunca cobra duas vezes. " +
    "Na primeira cobrança do paciente o emissor exige o CPF: se a resposta pedir CPF, peça à pessoa e chame de novo com ele. " +
    "Ao enviar o link, diga que a consulta é confirmada assim que o pagamento cair, e que ela recebe a confirmação por aqui. " +
    "Nunca diga que a consulta está confirmada antes disso, e nunca invente valor: o valor é o que esta ferramenta devolve.",
  inputSchema: cobrarShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    try {
      const r = await cobrarConsulta(criarDepsDeCobrar(createAdminClient()), {
        organizationId: ctx.organizationId,
        appointmentId: input.appointment_id,
        cpf: input.cpf ?? null,
      });
      if (!r.ok) return { cobrado: false, motivo: r.motivo, mensagem: ENSINO[r.motivo] };
      const valor = (r.valor_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      if (r.situacao === "pago") {
        return { cobrado: true, ja_pago: true, valor, mensagem: "esta consulta já está paga. Não envie link de novo." };
      }
      return {
        cobrado: true,
        link: r.link,
        valor,
        vencimento: r.vencimento,
        ja_existia: r.ja_existia,
        mensagem: r.ja_existia
          ? "este é o mesmo link já gerado para esta consulta. Reenvie só se a pessoa pedir."
          : "envie este link ao paciente com o valor. A consulta se confirma sozinha quando o pagamento cair.",
      };
    } catch (e) {
      // Asaas fora, chave revogada, resposta estranha: a conversa segue, a equipe cobra.
      logger.warn("[mcp] crm_charge_appointment falhou", {
        organization_id: ctx.organizationId,
        codigo: e instanceof ErroDoProvedor ? e.codigo : e instanceof Error ? e.name : "erro",
      });
      return { cobrado: false, motivo: "asaas_fora", mensagem: ENSINO.asaas_fora };
    }
  },
};
