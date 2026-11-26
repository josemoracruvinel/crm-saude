"use client";

/**
 * O cartão "Pagamento de consultas": a conta Asaas da clínica, onde cai o
 * dinheiro da consulta que o atendente de IA cobra.
 *
 * Mora no Financeiro porque é ali que a clínica descreve COMO o cliente paga.
 * A chave nunca volta ao browser: a tela vê os 4 últimos caracteres e se é o
 * ambiente de teste ou o de produção. Conectar já testa a chave e cadastra o
 * aviso de pagamento no Asaas — não há passo manual no painel do Asaas.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

interface Estado {
  conectada: boolean;
  ultimos4: string | null;
  modo: "teste" | "producao" | null;
  aviso_cadastrado: boolean;
}

async function lerCorpo(res: Response): Promise<{ data?: unknown; error?: { message?: string } }> {
  try {
    return (await res.json()) as { data?: unknown; error?: { message?: string } };
  } catch {
    return {};
  }
}

const ROTA = "/api/v1/financeiro/pagamento-de-consulta";

export function PagamentoDeConsultas({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [erroDeCarga, setErroDeCarga] = useState(false);
  const [chave, setChave] = useState("");
  const [ocupado, setOcupado] = useState<null | "conectar" | "desconectar">(null);

  const carregar = useCallback(async () => {
    const res = await fetch(ROTA).catch(() => null);
    if (!res || !res.ok) {
      setErroDeCarga(true);
      return;
    }
    setEstado((await lerCorpo(res)).data as Estado);
    setErroDeCarga(false);
  }, []);

  useEffect(() => {
    // Fora do corpo síncrono do efeito: o setState chega depois da resposta.
    void Promise.resolve().then(carregar);
  }, [carregar]);

  async function conectar() {
    setOcupado("conectar");
    try {
      const res = await fetch(ROTA, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: chave.trim() }),
      });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui conectar o Asaas."));
        void carregar();
        return;
      }
      setEstado(corpo.data as Estado);
      setChave("");
      toast.success(t("Conta Asaas conectada."));
    } finally {
      setOcupado(null);
    }
  }

  async function desconectar() {
    setOcupado("desconectar");
    try {
      const res = await fetch(ROTA, { method: "DELETE" });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui desconectar o Asaas."));
        return;
      }
      setEstado({ conectada: false, ultimos4: null, modo: null, aviso_cadastrado: false });
      toast.success(t("Conta Asaas desconectada."));
    } finally {
      setOcupado(null);
    }
  }

  return (
    <Card className="p-4" data-testid="cartao-pagamento-de-consultas">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Pagamento de consultas (Asaas)")}</h2>
        {estado &&
          (estado.conectada ? (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" data-testid="asaas-estado">
                {t("Conectada")} ···{estado.ultimos4}
              </Badge>
              <Badge variant="outline">{estado.modo === "teste" ? t("Ambiente de teste") : t("Produção")}</Badge>
              {!estado.aviso_cadastrado && <Badge variant="destructive">{t("Aviso de pagamento não cadastrado")}</Badge>}
            </div>
          ) : (
            <Badge variant="outline" data-testid="asaas-estado">
              {t("Não conectada")}
            </Badge>
          ))}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-text-muted">
        {t(
          "Com a conta conectada, o atendente de IA gera o link de pagamento da consulta e manda ao paciente. Quando o pagamento cai, a consulta se confirma sozinha. O dinheiro vai direto para a sua conta Asaas.",
        )}
      </p>

      {erroDeCarga && <p className="mt-3 text-sm text-destructive">{t("Não consegui ler a conexão com o Asaas.")}</p>}

      {podeEditar && (
        <>
          <div className="mt-4 space-y-2">
            <Label htmlFor="chave-do-asaas">
              {estado?.conectada ? t("Trocar a chave de API do Asaas") : t("Chave de API do Asaas")}
            </Label>
            <Input
              id="chave-do-asaas"
              type="password"
              autoComplete="off"
              value={chave}
              onChange={(e) => setChave(e.target.value)}
              placeholder="$aact_…"
              data-testid="asaas-chave"
            />
            <p className="text-xs text-text-muted">
              {t(
                "No Asaas: Integrações › Chave de API. A chave do ambiente de teste começa com $aact_hmlg_ e não movimenta dinheiro de verdade. Também ligue a capacidade Cobrar a consulta no agente e preencha o preço do tipo de consulta.",
              )}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={conectar} disabled={!chave.trim() || ocupado !== null} data-testid="asaas-conectar">
              {ocupado === "conectar" ? t("Conectando…") : t("Conectar")}
            </Button>
            {estado?.conectada && (
              <Button variant="ghost" onClick={desconectar} disabled={ocupado !== null} data-testid="asaas-desconectar">
                {t("Desconectar")}
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
