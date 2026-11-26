/**
 * A CONEXÃO ASAAS DA CLÍNICA (`consulta_pagamento_conexoes`, migration 9222).
 *
 * Opcional: sem conexão, nada muda — a ferramenta de cobrar responde que não há
 * como cobrar e a IA segue com o texto antigo ("a equipe envia o link").
 *
 * A chave é cifrada por `fn_encrypt_oauth` (mesma cifra de
 * `map_provider_credentials`) e nunca volta ao browser: a tela vê os 4 últimos
 * caracteres. Do token do aviso de pagamento só o sha256 é gravado.
 *
 * ⚠️ Service role: toda consulta filtra `organization_id` à mão, e o id vem de
 * fonte confiável (sessão, id da conexão no caminho do aviso), nunca do corpo.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";
import { modoDaChaveAsaas } from "@/lib/cobranca/provedores/asaas";
import { urlPublicaUsavel } from "@/lib/escalacao/url-publica";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { criarAsaasDaClinica, type AsaasDaClinica } from "./asaas";

const TABELA = "consulta_pagamento_conexoes";

/** `$aact_prod_…` ou `$aact_hmlg_…`: o formato barra a colagem errada antes de cifrar. */
export const chaveDoAsaasSchema = z
  .string()
  .trim()
  .min(20)
  .max(300)
  .refine((v) => modoDaChaveAsaas(v) !== null);

export type ModoDaConexao = "teste" | "producao";

export interface EstadoDaConexao {
  conectada: boolean;
  ultimos4: string | null;
  modo: ModoDaConexao | null;
  avisoCadastrado: boolean;
  atualizadaEm: string | null;
}

interface LinhaDaConexao {
  id: string;
  api_key_encrypted: string;
  api_key_last4: string;
  modo: ModoDaConexao;
  webhook_id: string | null;
  webhook_token_hash: string | null;
  updated_at: string;
}

export const hashDoToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Compara o token recebido com o hash gravado sem atalho de tempo. Nunca lança. */
export function tokenConfere(recebido: string | null, hashGravado: string | null): boolean {
  if (!recebido || !hashGravado || !/^[0-9a-f]{64}$/.test(hashGravado)) return false;
  return timingSafeEqual(Buffer.from(hashDoToken(recebido), "hex"), Buffer.from(hashGravado, "hex"));
}

/** O endereço que o Asaas chama, ou `null` quando a instalação não tem https público. */
export function urlDoAviso(base: string, conexaoId: string): string | null {
  const limpa = base.trim().replace(/\/+$/, "");
  if (!URL.canParse(limpa) || new URL(limpa).protocol !== "https:" || !urlPublicaUsavel(limpa)) return null;
  return `${limpa}/api/v1/webhooks/pagamento-de-consulta/asaas/${conexaoId}`;
}

async function linha(admin: SupabaseClient, organizationId: string): Promise<LinhaDaConexao | null> {
  const { data, error } = await admin
    .from(TABELA)
    .select("id, api_key_encrypted, api_key_last4, modo, webhook_id, webhook_token_hash, updated_at")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(`leitura da conexão Asaas falhou: ${error.message}`);
  return (data as LinhaDaConexao | null) ?? null;
}

export async function estadoDaConexao(admin: SupabaseClient, organizationId: string): Promise<EstadoDaConexao> {
  const l = await linha(admin, organizationId);
  return {
    conectada: Boolean(l),
    ultimos4: l?.api_key_last4 ?? null,
    modo: l?.modo ?? null,
    avisoCadastrado: Boolean(l?.webhook_id && l.webhook_token_hash),
    atualizadaEm: l?.updated_at ?? null,
  };
}

/** O cliente Asaas da clínica, ou `null` (sem conexão, cifra indisponível). Nunca lança. */
export async function asaasDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ asaas: AsaasDaClinica; modo: ModoDaConexao; conexaoId: string } | null> {
  try {
    const l = await linha(admin, organizationId);
    if (!l) return null;
    const chave = await decryptWebhookSecret(admin, l.api_key_encrypted);
    if (!chave) return null;
    return { asaas: criarAsaasDaClinica({ chave }), modo: l.modo, conexaoId: l.id };
  } catch (err) {
    logger.warn("[pagamento-de-consulta] conexão ilegível", {
      organization_id: organizationId,
      error: err instanceof Error ? err.name : "erro",
    });
    return null;
  }
}

/** A conexão dona do aviso, pelo id do caminho. O hash volta para a rota conferir o token. */
export async function conexaoDoAviso(
  admin: SupabaseClient,
  conexaoId: string,
): Promise<{ organizationId: string; tokenHash: string | null } | null> {
  if (!z.string().uuid().safeParse(conexaoId).success) return null;
  const { data, error } = await admin
    .from(TABELA)
    .select("organization_id, webhook_token_hash")
    .eq("id", conexaoId)
    .maybeSingle();
  if (error) throw new Error(`leitura da conexão do aviso falhou: ${error.message}`);
  const d = data as { organization_id: string; webhook_token_hash: string | null } | null;
  return d ? { organizationId: d.organization_id, tokenHash: d.webhook_token_hash } : null;
}

export type ResultadoDaConexao =
  | { ok: true; estado: EstadoDaConexao; trocou: boolean }
  | {
      ok: false;
      erro: "chave_invalida" | "sem_permissao" | "provedor_fora" | "cifra_indisponivel" | "sem_url_publica" | "aviso_recusado" | "erro_ao_gravar";
    };

/**
 * Conecta (ou troca) a conta. Ordem: testa a chave → grava cifrada → cadastra o
 * aviso → grava o hash do token → só então apaga o aviso da conexão anterior.
 * Falha no meio deixa a conexão gravada sem aviso; a tela mostra "aviso não
 * cadastrado" e conectar de novo cura.
 */
export async function conectarAsaas(
  admin: SupabaseClient,
  input: { organizationId: string; chave: string; atorId: string; emailDoAtor: string; baseUrl: string },
): Promise<ResultadoDaConexao> {
  const asaas = criarAsaasDaClinica({ chave: input.chave });
  const teste = await asaas.testar();
  if (!teste.ok) return { ok: false, erro: teste.motivo };

  const cifrada = await encryptWebhookSecret(admin, input.chave);
  if (!cifrada) return { ok: false, erro: "cifra_indisponivel" };

  const anterior = await linha(admin, input.organizationId);
  const { data: gravada, error } = await admin
    .from(TABELA)
    .upsert(
      {
        organization_id: input.organizationId,
        provider: "asaas",
        api_key_encrypted: cifrada,
        api_key_last4: input.chave.slice(-4),
        modo: teste.modo,
        webhook_id: null,
        webhook_token_hash: null,
        updated_by: input.atorId,
      },
      { onConflict: "organization_id" },
    )
    .select("id")
    .single();
  if (error || !gravada) return { ok: false, erro: "erro_ao_gravar" };
  const conexaoId = (gravada as { id: string }).id;

  // O aviso antigo morava na conta da chave ANTERIOR — que pode ser outra conta.
  if (anterior?.webhook_id) {
    try {
      const chaveAntiga = await decryptWebhookSecret(admin, anterior.api_key_encrypted);
      if (chaveAntiga) await criarAsaasDaClinica({ chave: chaveAntiga }).removerAviso(anterior.webhook_id);
    } catch (err) {
      logger.warn("[pagamento-de-consulta] aviso antigo não removido", {
        organization_id: input.organizationId,
        codigo: err instanceof ErroDoProvedor ? err.codigo : "erro",
      });
    }
  }

  const url = urlDoAviso(input.baseUrl, conexaoId);
  if (!url) return { ok: false, erro: "sem_url_publica" };
  let aviso: { id: string; token: string };
  try {
    aviso = await asaas.cadastrarAviso(url, input.emailDoAtor);
  } catch (err) {
    logger.warn("[pagamento-de-consulta] aviso recusado pelo Asaas", {
      organization_id: input.organizationId,
      codigo: err instanceof ErroDoProvedor ? err.codigo : "erro",
    });
    return { ok: false, erro: "aviso_recusado" };
  }
  const { error: erroDoAviso } = await admin
    .from(TABELA)
    .update({ webhook_id: aviso.id, webhook_token_hash: hashDoToken(aviso.token) })
    .eq("organization_id", input.organizationId)
    .eq("id", conexaoId);
  if (erroDoAviso) {
    await asaas.removerAviso(aviso.id).catch(() => undefined);
    return { ok: false, erro: "erro_ao_gravar" };
  }
  return { ok: true, estado: await estadoDaConexao(admin, input.organizationId), trocou: Boolean(anterior) };
}

/** Remove o aviso no Asaas (melhor esforço) e a conexão. `true` se havia conexão. */
export async function desconectarAsaas(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  const l = await linha(admin, organizationId);
  if (!l) return false;
  if (l.webhook_id) {
    try {
      const chave = await decryptWebhookSecret(admin, l.api_key_encrypted);
      if (chave) await criarAsaasDaClinica({ chave }).removerAviso(l.webhook_id);
    } catch (err) {
      logger.warn("[pagamento-de-consulta] aviso não removido ao desconectar", {
        organization_id: organizationId,
        codigo: err instanceof ErroDoProvedor ? err.codigo : "erro",
      });
    }
  }
  const { error } = await admin.from(TABELA).delete().eq("organization_id", organizationId).eq("id", l.id);
  if (error) throw new Error(`remoção da conexão Asaas falhou: ${error.message}`);
  return true;
}
