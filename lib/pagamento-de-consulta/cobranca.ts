/**
 * A COBRANÇA DA CONSULTA — gerar o link e, quando o pagamento cai, confirmar.
 *
 * Desenho: docs/superpowers/specs/2026-11-26-cobranca-da-consulta-asaas-design.md
 *
 * Duas regras, as duas puras sobre dependências (os testes dublam o banco e o
 * Asaas):
 *
 *   `cobrarConsulta`       — a ferramenta da IA. Uma cobrança VIVA por consulta:
 *                            chamar de novo devolve o MESMO link, nunca cobra duas vezes.
 *   `processarPagamento`   — o aviso do Asaas. Relê a cobrança na API (o corpo do
 *                            aviso nunca decide nada) e, se pagou e a consulta
 *                            ainda está reservada, CONFIRMA a consulta — e o
 *                            cartão do funil anda pelo `appointment.confirmed`
 *                            (1.104.3).
 *
 * ⚠️ PAGOU DEPOIS QUE A RESERVA EXPIROU: o dinheiro está na conta da clínica e a
 * vaga pode já ser de outra pessoa. Nada é confirmado sozinho; a equipe recebe um
 * aviso na Central para remarcar ou estornar.
 */
import type { SituacaoDaCobranca, CobrancaLida, AsaasDaClinica } from "./asaas";
import type { ModoDaConexao } from "./conexao";

export interface ConsultaDaCobranca {
  status: string;
  contact_id: string | null;
  /** Quem atende: vira o profissional da comanda e decide a comissão. */
  owner_user_id?: string | null;
  conversation_id: string | null;
  event_type_id: string | null;
  starts_at: string;
  time_zone: string;
  title: string;
}

export interface CobrancaGuardada {
  id: string;
  provider_payment_id: string;
  appointment_id: string | null;
  situacao: SituacaoDaCobranca;
  link: string | null;
  valor_cents: number;
  vencimento: string | null;
  confirmou_consulta: boolean;
}

/* ── Gerar a cobrança ────────────────────────────────────────────────────── */

export interface CobrarDeps {
  conexao(orgId: string): Promise<{ asaas: AsaasDaClinica; modo: ModoDaConexao } | null>;
  consulta(orgId: string, appointmentId: string): Promise<ConsultaDaCobranca | null>;
  precoDoTipo(orgId: string, eventTypeId: string): Promise<number | null>;
  cobrancaViva(orgId: string, appointmentId: string): Promise<CobrancaGuardada | null>;
  clienteGuardado(orgId: string, contactId: string, modo: ModoDaConexao): Promise<string | null>;
  guardaCliente(orgId: string, contactId: string, modo: ModoDaConexao, clienteId: string): Promise<void>;
  nomeDoContato(orgId: string, contactId: string): Promise<string | null>;
  /** Grava o CPF cifrado na ficha SÓ se ela ainda não tem. Melhor esforço. */
  guardaCpfNaFicha(orgId: string, contactId: string, cpf: string): Promise<void>;
  prazoDaReservaMinutos(orgId: string): Promise<number>;
  /** `false` = já havia outra cobrança viva para a consulta (corrida perdida). */
  insereCobranca(linha: {
    organization_id: string;
    appointment_id: string;
    contact_id: string;
    modo: ModoDaConexao;
    provider_payment_id: string;
    valor_cents: number;
    situacao: SituacaoDaCobranca;
    link: string | null;
    vencimento: string | null;
  }): Promise<boolean>;
  clock(): Date;
}

export type ResultadoDaCobranca =
  | {
      ok: true;
      link: string;
      valor_cents: number;
      vencimento: string | null;
      situacao: SituacaoDaCobranca;
      ja_existia: boolean;
    }
  | {
      ok: false;
      motivo:
        | "sem_conexao"
        | "consulta_inexistente"
        | "consulta_cancelada"
        | "sem_contato"
        | "sem_preco"
        | "cpf_necessario"
        | "cpf_invalido"
        | "sem_link";
    };

/** `AAAA-MM-DD` no fuso de São Paulo: o `dueDate` do Asaas é data civil. */
export function dataCivil(instante: Date, fuso = "America/Sao_Paulo"): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instante);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}`;
}

/**
 * O vencimento acompanha o prazo da reserva: depois dele a vaga volta para a
 * agenda, e a cobrança não deve seguir aceitando pagamento. Nunca antes de hoje
 * (o Asaas recusa) e nunca depois do dia da consulta.
 */
export function vencimentoDaCobranca(agora: Date, prazoMinutos: number, inicioDaConsulta: string): string {
  const hoje = dataCivil(agora);
  const fimDoPrazo = dataCivil(new Date(agora.getTime() + Math.max(0, prazoMinutos) * 60_000));
  const diaDaConsulta = Number.isNaN(Date.parse(inicioDaConsulta)) ? fimDoPrazo : dataCivil(new Date(inicioDaConsulta));
  const limite = fimDoPrazo < diaDaConsulta ? fimDoPrazo : diaDaConsulta;
  return limite < hoje ? hoje : limite;
}

const SITUACOES_QUE_ACEITAM_COBRANCA = new Set(["pending", "confirmed"]);

export async function cobrarConsulta(
  deps: CobrarDeps,
  input: { organizationId: string; appointmentId: string; cpf?: string | null },
): Promise<ResultadoDaCobranca> {
  const org = input.organizationId;
  const conexao = await deps.conexao(org);
  if (!conexao) return { ok: false, motivo: "sem_conexao" };

  const consulta = await deps.consulta(org, input.appointmentId);
  if (!consulta) return { ok: false, motivo: "consulta_inexistente" };
  if (!SITUACOES_QUE_ACEITAM_COBRANCA.has(consulta.status)) return { ok: false, motivo: "consulta_cancelada" };
  if (!consulta.contact_id) return { ok: false, motivo: "sem_contato" };
  const contactId = consulta.contact_id;

  // Cobrança viva primeiro: a segunda chamada devolve o MESMO link.
  const viva = await deps.cobrancaViva(org, input.appointmentId);
  if (viva?.link) {
    return { ok: true, link: viva.link, valor_cents: viva.valor_cents, vencimento: viva.vencimento, situacao: viva.situacao, ja_existia: true };
  }

  const preco = consulta.event_type_id ? await deps.precoDoTipo(org, consulta.event_type_id) : null;
  if (!preco || preco <= 0) return { ok: false, motivo: "sem_preco" };

  let cliente = await deps.clienteGuardado(org, contactId, conexao.modo);
  const cpf = input.cpf?.replace(/\D/g, "") ?? "";
  if (!cliente) {
    if (!cpf) return { ok: false, motivo: "cpf_necessario" };
    const nome = (await deps.nomeDoContato(org, contactId))?.trim() || "Paciente";
    try {
      cliente = await conexao.asaas.garantirCliente({ nome, cpf, referencia: contactId });
    } catch (e) {
      if (e instanceof Error && "codigo" in e && (e as { codigo: string }).codigo === "documento_invalido") {
        return { ok: false, motivo: "cpf_invalido" };
      }
      throw e;
    }
    await deps.guardaCliente(org, contactId, conexao.modo, cliente);
    await deps.guardaCpfNaFicha(org, contactId, cpf);
  }

  const agora = deps.clock();
  const vencimento = vencimentoDaCobranca(agora, await deps.prazoDaReservaMinutos(org), consulta.starts_at);
  const criada = await conexao.asaas.criarCobranca({
    cliente,
    valorCents: preco,
    vencimento,
    descricao: consulta.title,
    referencia: input.appointmentId,
  });
  if (!criada.link) {
    await conexao.asaas.cancelarCobranca(criada.id).catch(() => undefined);
    return { ok: false, motivo: "sem_link" };
  }

  const entrou = await deps.insereCobranca({
    organization_id: org,
    appointment_id: input.appointmentId,
    contact_id: contactId,
    modo: conexao.modo,
    provider_payment_id: criada.id,
    valor_cents: preco,
    situacao: criada.situacao,
    link: criada.link,
    vencimento: criada.vencimento ?? vencimento,
  });
  if (!entrou) {
    // Outra chamada ganhou a corrida: a cobrança dela vale, a nossa sai do Asaas.
    await conexao.asaas.cancelarCobranca(criada.id).catch(() => undefined);
    const vencedora = await deps.cobrancaViva(org, input.appointmentId);
    if (vencedora?.link) {
      return { ok: true, link: vencedora.link, valor_cents: vencedora.valor_cents, vencimento: vencedora.vencimento, situacao: vencedora.situacao, ja_existia: true };
    }
    return { ok: false, motivo: "sem_link" };
  }
  return { ok: true, link: criada.link, valor_cents: preco, vencimento: criada.vencimento ?? vencimento, situacao: criada.situacao, ja_existia: false };
}

/* ── O aviso de pagamento ────────────────────────────────────────────────── */

export interface ProcessarDeps {
  conexao(orgId: string): Promise<{ asaas: AsaasDaClinica } | null>;
  cobrancaPorId(orgId: string, providerPaymentId: string): Promise<CobrancaGuardada | null>;
  atualizaCobranca(orgId: string, id: string, lida: CobrancaLida, pagoEm: string | null): Promise<void>;
  consulta(orgId: string, appointmentId: string): Promise<ConsultaDaCobranca | null>;
  /** Confirma pelo caminho da Agenda (emite `appointment.confirmed`). `false` = já não estava reservada. */
  confirmaConsulta(orgId: string, appointmentId: string): Promise<boolean>;
  /** Marca que ESTE pagamento confirmou a consulta. `false` = outro aviso já marcou. */
  marcaQueConfirmou(orgId: string, id: string): Promise<boolean>;
  avisaPaciente(orgId: string, consulta: ConsultaDaCobranca): Promise<void>;
  avisaEquipe(orgId: string, appointmentId: string | null, motivo: "pago_sem_reserva"): Promise<void>;
  /**
   * Abre a comanda da consulta paga, no nome do profissional que atende (o
   * repasse semanal sai da "Comissão por pessoa" do Faturamento). Idempotente
   * pela comanda única por consulta; melhor esforço, nunca lança.
   */
  abreComanda(orgId: string, appointmentId: string, consulta: ConsultaDaCobranca, cobranca: CobrancaGuardada): Promise<void>;
  clock(): Date;
}

export type DesfechoDoAviso =
  | "sem_conexao"
  | "cobranca_desconhecida"
  | "registrado"
  | "confirmou"
  | "ja_confirmada"
  | "pago_sem_reserva";

export async function processarPagamento(
  deps: ProcessarDeps,
  input: { organizationId: string; providerPaymentId: string },
): Promise<DesfechoDoAviso> {
  const org = input.organizationId;
  const conexao = await deps.conexao(org);
  if (!conexao) return "sem_conexao";
  const guardada = await deps.cobrancaPorId(org, input.providerPaymentId);
  // Cobrança que não nasceu aqui (feita à mão no painel do Asaas): não é nossa.
  if (!guardada) return "cobranca_desconhecida";

  const lida = await conexao.asaas.lerCobranca(input.providerPaymentId);
  const pagoAgora = lida.situacao === "pago" && guardada.situacao !== "pago";
  await deps.atualizaCobranca(org, guardada.id, lida, pagoAgora ? deps.clock().toISOString() : null);

  if (lida.situacao !== "pago" || guardada.confirmou_consulta || !guardada.appointment_id) return "registrado";

  const consulta = await deps.consulta(org, guardada.appointment_id);
  if (!consulta || consulta.status === "cancelled") {
    await deps.avisaEquipe(org, guardada.appointment_id, "pago_sem_reserva");
    return "pago_sem_reserva";
  }
  // Medido no teste de 26/11/2026: a consulta já estava CONFIRMADA (a equipe, ou
  // um tipo sem confirmação, confirmou antes) e a IA cobrou mesmo assim, dizendo
  // ao paciente "eu te aviso por aqui quando o pagamento cair". Só registrar
  // deixava essa promessa sem cumprir. Agora o paciente recebe o MESMO aviso;
  // a consulta não é mexida (já estava confirmada) e o cartão não anda de novo.
  if (consulta.status === "confirmed") {
    if (await deps.marcaQueConfirmou(org, guardada.id)) await deps.avisaPaciente(org, consulta);
    await deps.abreComanda(org, guardada.appointment_id, consulta, guardada);
    return "ja_confirmada";
  }
  // Situação que não é reserva nem confirmação (atendida, faltou): só registra.
  if (consulta.status !== "pending") return "registrado";

  const confirmou = await deps.confirmaConsulta(org, guardada.appointment_id);
  if (!confirmou) return "ja_confirmada";
  // A marca é a trava contra aviso repetido: só quem a gravou avisa o paciente.
  if (await deps.marcaQueConfirmou(org, guardada.id)) await deps.avisaPaciente(org, consulta);
  // A comanda nasce AGORA, com o dinheiro na conta; ela é FECHADA pela equipe
  // depois da consulta (o banco exige pessoa e horário já passado para concluir
  // o atendimento) — é esse fechamento que lança a comissão do repasse.
  await deps.abreComanda(org, guardada.appointment_id, consulta, guardada);
  return "confirmou";
}
