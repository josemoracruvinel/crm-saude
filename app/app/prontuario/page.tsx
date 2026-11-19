import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { destinoDoProntuario } from "@/lib/prontuario/destino";

/**
 * Fluxo Care — a porta "Prontuário" do menu.
 *
 * O prontuário é um app separado, em repositório próprio, com o mesmo login.
 * Esta página não mostra dado clínico nenhum: só leva ao endereço gravado em
 * Admin › Credenciais (`PRONTUARIO_URL`). Quem decide quem vê paciente é o
 * prontuário (só profissional cadastrado), não este menu.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Prontuário" };

export default async function ProntuarioPage() {
  const user = await requireAuth();
  const { valor } = await valorDaInstalacao("PRONTUARIO_URL");
  const destino = destinoDoProntuario(valor);
  if (destino) redirect(destino);

  const t = (texto: string) => traduzir(texto, user.idioma);
  return (
    <div className="flex h-full flex-col gap-4 md:p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("Prontuário")}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t(
          "O prontuário ainda não está ligado nesta instalação. Quem administra a plataforma grava o endereço dele em Admin › Credenciais.",
        )}
      </p>
    </div>
  );
}
