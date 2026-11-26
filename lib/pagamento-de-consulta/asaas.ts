/**
 * O ASAAS DA CLÍNICA — a conta onde cai o dinheiro da consulta do paciente.
 *
 * Não é o adaptador de `lib/cobranca/provedores/asaas.ts`: aquele é a conta da
 * PLATAFORMA cobrando as clínicas (uma chave só, assinatura recorrente). Este é a
 * conta de CADA clínica cobrando os pacientes (uma chave por organização, uma
 * cobrança avulsa por consulta). As regras de transporte são as mesmas, e por
 * isso os pedaços puros vêm de lá:
 *
 * - A chave vai SÓ no header `access_token`: nunca em query string, log, erro,
 *   audit ou Sentry. O erro leva o status e o `code` do Asaas, nunca a
 *   `description`, que ecoa dado do pagador (`erroDoAsaas`).
 * - O ambiente sai do prefixo da chave (`$aact_hmlg_` = teste).
 * - O Asaas não aceita chave de idempotência: GET e DELETE repetem em 429, 5xx e
 *   rede; POST repete SÓ em 429. A idempotência do POST é de quem chama (o
 *   índice `consulta_pagamentos_uma_viva_por_consulta` e a busca do cliente).
 */
import { randomBytes } from "node:crypto";

import { z } from "zod";

import { documentoDoPagador } from "@/lib/cobranca/documento";
import { ASAAS_API_BASE, erroDoAsaas, modoDaChaveAsaas } from "@/lib/cobranca/provedores/asaas";
import { ErroDoProvedor, type Modo } from "@/lib/cobranca/provedores/contrato";
import { logger } from "@/lib/logger";

const TENTATIVAS = 3;
const ESPERA_MAXIMA_MS = 5_000;
const TEMPO_LIMITE_MS = 20_000;

/** Os avisos que acordam a releitura de uma cobrança. Nenhum carrega estado. */
export const EVENTOS_DO_AVISO_DE_PAGAMENTO = [
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_RESTORED",
  "PAYMENT_REFUNDED",
] as const;

/** Situação do Asaas → a nossa. `CONFIRMED` = cartão aprovado; `RECEIVED` = Pix ou boleto compensado. */
export type SituacaoDaCobranca = "pendente" | "pago" | "vencido" | "cancelado" | "estornado";

export function situacaoDoAsaas(status: string, removida: boolean): SituacaoDaCobranca {
  if (removida) return "cancelado";
  if (status === "CONFIRMED" || status === "RECEIVED" || status === "RECEIVED_IN_CASH") return "pago";
  if (status === "OVERDUE") return "vencido";
  if (status === "REFUNDED" || status === "REFUND_REQUESTED" || status.startsWith("CHARGEBACK")) return "estornado";
  if (status === "PENDING" || status === "AWAITING_RISK_ANALYSIS") return "pendente";
  // Status novo que o Asaas venha a inventar: tratar como não pago é o lado seguro.
  return "pendente";
}

const comId = z.object({ id: z.string().min(1), deleted: z.boolean().nullish() });
const lista = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });
const cobrancaDoAsaas = z.object({
  id: z.string().min(1),
  status: z.string(),
  deleted: z.boolean().nullish(),
  dueDate: z.string().nullish(),
  invoiceUrl: z.string().nullish(),
  externalReference: z.string().nullish(),
  value: z.number().nullish(),
});

export interface CobrancaLida {
  id: string;
  situacao: SituacaoDaCobranca;
  link: string | null;
  vencimento: string | null;
  referencia: string | null;
  valorCents: number | null;
}

export interface DependenciasDoAsaasDaClinica {
  chave: string;
  fetch?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
}

function ler<T>(schema: z.ZodType<T>, dados: unknown): T {
  const lido = schema.safeParse(dados);
  if (!lido.success) throw new ErroDoProvedor(200, "resposta_invalida", false);
  return lido.data;
}

function espera(tentativa: number, pedida: string | null): number {
  const ms = pedida !== null && /^\d+$/.test(pedida) ? Number(pedida) * 1000 : 500 * 2 ** (tentativa - 1);
  return Math.min(ms, ESPERA_MAXIMA_MS);
}

/** Link que vira mensagem ao paciente: só https. Uma resposta adulterada com `javascript:` nunca sai. */
export function linkSeguro(u: string | null | undefined): string | null {
  if (!u || !URL.canParse(u)) return null;
  return new URL(u).protocol === "https:" ? u : null;
}

function lerCobranca(bruto: unknown): CobrancaLida {
  const c = ler(cobrancaDoAsaas, bruto);
  return {
    id: c.id,
    situacao: situacaoDoAsaas(c.status, c.deleted === true),
    link: linkSeguro(c.invoiceUrl),
    vencimento: c.dueDate ?? null,
    referencia: c.externalReference ?? null,
    valorCents: typeof c.value === "number" ? Math.round(c.value * 100) : null,
  };
}

export function criarAsaasDaClinica(dep: DependenciasDoAsaasDaClinica) {
  const modo: Modo | null = modoDaChaveAsaas(dep.chave);
  const buscar = dep.fetch ?? fetch;
  const esperar = dep.esperar ?? ((ms: number) => new Promise<void>((pronto) => setTimeout(pronto, ms)));

  async function chamar(metodo: "GET" | "POST" | "DELETE", caminho: string, corpo?: Record<string, unknown>): Promise<unknown> {
    if (modo === null) throw new ErroDoProvedor(null, "chave_invalida", false, true);
    const headers: Record<string, string> = {
      access_token: dep.chave,
      "user-agent": "cobranca-da-consulta",
      accept: "application/json",
    };
    const body = corpo === undefined ? undefined : JSON.stringify(corpo);
    if (body !== undefined) headers["content-type"] = "application/json";
    for (let tentativa = 1; ; tentativa += 1) {
      let erro: ErroDoProvedor;
      let pedida: string | null = null;
      try {
        const r = await buscar(`${ASAAS_API_BASE[modo]}${caminho}`, {
          method: metodo,
          headers,
          body,
          cache: "no-store",
          signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
        });
        if (r.ok) {
          return await r.json().catch(() => {
            throw new ErroDoProvedor(r.status, "resposta_invalida", false);
          });
        }
        erro = erroDoAsaas(r.status, await r.json().catch(() => null));
        pedida = r.headers.get("retry-after");
      } catch (e) {
        if (e instanceof ErroDoProvedor) throw e;
        erro = new ErroDoProvedor(null, "sem_resposta", true);
      }
      // POST sem idempotência: repetir depois de 5xx ou rede poderia cobrar em dobro.
      const repetivel = metodo === "POST" ? erro.status === 429 : erro.transitorio;
      if (!(tentativa < TENTATIVAS && repetivel)) throw erro;
      logger.warn("pagamento_de_consulta.asaas.nova_tentativa", { status: erro.status, codigo: erro.codigo, tentativa });
      await esperar(espera(tentativa, pedida));
    }
  }

  return {
    modo,

    /** A chave autentica no ambiente do prefixo? */
    async testar(): Promise<{ ok: true; modo: Modo } | { ok: false; motivo: "chave_invalida" | "sem_permissao" | "provedor_fora" }> {
      if (modo === null) return { ok: false, motivo: "chave_invalida" };
      try {
        await chamar("GET", "/customers?limit=1");
        return { ok: true, modo };
      } catch (e) {
        if (!(e instanceof ErroDoProvedor)) throw e;
        if (e.status === 401) return { ok: false, motivo: "chave_invalida" };
        if (e.status === 403) return { ok: false, motivo: "sem_permissao" };
        return { ok: false, motivo: "provedor_fora" };
      }
    },

    /**
     * Cadastra o aviso de pagamento na conta da clínica. O token é NOSSO (32
     * bytes); o Asaas o ecoa em cada aviso e só o hash dele é gravado. O Asaas
     * recusa dois avisos com a mesma URL, então cada conexão ganha uma query
     * própria, que a rota ignora.
     */
    async cadastrarAviso(url: string, email: string): Promise<{ id: string; token: string }> {
      const token = randomBytes(32).toString("base64url");
      const comMarca = `${url.split("?")[0]}?c=${randomBytes(4).toString("hex")}`;
      const criado = ler(
        comId,
        await chamar("POST", "/webhooks", {
          name: "Cobrança da consulta",
          url: comMarca,
          email,
          enabled: true,
          interrupted: false,
          apiVersion: 3,
          sendType: "SEQUENTIALLY",
          authToken: token,
          events: [...EVENTOS_DO_AVISO_DE_PAGAMENTO],
        }),
      );
      return { id: criado.id, token };
    },

    /** 404 é o efeito desejado (alguém apagou antes): não é falha. */
    async removerAviso(id: string): Promise<void> {
      try {
        await chamar("DELETE", `/webhooks/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!(e instanceof ErroDoProvedor && e.status === 404)) throw e;
      }
    },

    /**
     * O cliente do paciente: busca pelo CPF antes de criar (o POST não tem
     * idempotência). `notificationDisabled`: quem fala com o paciente é a
     * clínica, pelo WhatsApp; os e-mails e SMS do Asaas sairiam em dobro.
     */
    async garantirCliente(p: { nome: string; cpf: string; referencia: string }): Promise<string> {
      const documento = documentoDoPagador(p.cpf);
      if (documento === null) throw new ErroDoProvedor(null, "documento_invalido", false);
      const consulta = new URLSearchParams({ cpfCnpj: documento, limit: "10" });
      const achado = ler(lista(comId), await chamar("GET", `/customers?${consulta}`)).data.find((c) => c.deleted !== true);
      if (achado) return achado.id;
      return ler(
        comId,
        await chamar("POST", "/customers", {
          name: p.nome,
          cpfCnpj: documento,
          externalReference: p.referencia,
          notificationDisabled: true,
        }),
      ).id;
    },

    /** Cobrança avulsa: o paciente escolhe Pix ou cartão na página do Asaas (`UNDEFINED`). */
    async criarCobranca(p: {
      cliente: string;
      valorCents: number;
      vencimento: string;
      descricao: string;
      referencia: string;
    }): Promise<CobrancaLida> {
      return lerCobranca(
        await chamar("POST", "/payments", {
          customer: p.cliente,
          billingType: "UNDEFINED",
          value: p.valorCents / 100,
          dueDate: p.vencimento,
          description: p.descricao.slice(0, 500),
          externalReference: p.referencia,
        }),
      );
    },

    async lerCobranca(id: string): Promise<CobrancaLida> {
      return lerCobranca(await chamar("GET", `/payments/${encodeURIComponent(id)}`));
    },

    /** Remove a cobrança pendente: o link para de aceitar pagamento. 404 = já não existe. */
    async cancelarCobranca(id: string): Promise<void> {
      try {
        await chamar("DELETE", `/payments/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!(e instanceof ErroDoProvedor && e.status === 404)) throw e;
      }
    },
  };
}

export type AsaasDaClinica = ReturnType<typeof criarAsaasDaClinica>;
