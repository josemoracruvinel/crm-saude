/**
 * Cerca: rota que usa o cliente de service role (ignora a RLS) precisa tratar
 * da organização — auditoria Fluxo Care, etapa 2.
 *
 * A doutrina (CLAUDE.md, Multi-tenancy) diz que todo handler com admin client
 * DEVE filtrar `organization_id` à mão, resolvido de fonte confiável. Esta
 * cerca é o fio de tropeço barato dessa regra: todo `route.ts` de `app/api` que
 * importa `createAdminClient` precisa mencionar a organização
 * (`organization_id`, `organizationId` ou `orgId`). Mencionar não PROVA o
 * filtro — quem prova o isolamento são os invariantes de `tests/invariants/` —,
 * mas uma rota nova que nem toca no assunto é exatamente o esquecimento que
 * vaza dado entre clínicas, e ela reprova aqui.
 *
 * As exceções são rotas que, por natureza, não pertencem a uma organização. A
 * lista SÓ ENCOLHE: entrada nova exige o motivo escrito, e entrada que deixou
 * de ser necessária (o arquivo sumiu ou passou a mencionar a organização)
 * reprova até ser removida.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

const EXCECOES: Record<string, string> = {
  // Painel do dono da instalação: atua sobre todas as organizações por definição.
  "app/api/v1/admin/cobranca/regua/route.ts": "régua de cobrança da instalação (platform admin)",
  "app/api/v1/admin/platform-admins/route.ts": "gestão de platform admins, sem tenant",
  "app/api/v1/admin/tenants/export/route.ts": "exportação de tenants pelo platform admin",
  // Crons: varrem todas as organizações; cada efeito usa a org da própria linha.
  "app/api/v1/cron/campaign-worker/route.ts": "cron que varre todas as organizações",
  "app/api/v1/cron/cobranca/route.ts": "cron que varre todas as organizações",
  "app/api/v1/cron/event-log-drain/route.ts": "cron que drena o event_log de todas as organizações",
  "app/api/v1/cron/mcp-oauth-revogacao/route.ts": "cron de revogação de tokens vencidos",
  "app/api/v1/cron/prospecting/route.ts": "cron que varre todas as organizações",
  "app/api/v1/cron/sync-model-catalog/route.ts": "catálogo de modelos é da instalação",
  // Admin client só para `moduloLigado` (estado da instalação); os dados vão pela sessão (RLS).
  "app/api/v1/financeiro/comandas/[id]/itens/[itemId]/route.ts": "admin só em moduloLigado; dados pela sessão",
  "app/api/v1/financeiro/comandas/[id]/route.ts": "admin só em moduloLigado; dados pela sessão",
  "app/api/v1/financeiro/comandas/pendentes/route.ts": "admin só em moduloLigado; dados pela sessão",
  // A organização vem do `state` opaco e de uso único gravado no início do fluxo.
  "app/api/v1/mcp-oauth/callback/[servidor]/route.ts": "org resolvida pelo state do OAuth",
  "app/api/v1/mcp-oauth/iniciar/[state]/route.ts": "org resolvida pelo state do OAuth",
  // Atualização e versão do sistema: estado da instalação, não de tenant.
  "app/api/v1/system/agent/route.ts": "agente de atualização da instalação",
  "app/api/v1/system/update/route.ts": "pedido de atualização da instalação",
  "app/api/v1/system/version/route.ts": "versão da instalação",
  // A sessão do canal é achada pela assinatura do webhook, e a org vem dela.
  "app/api/v1/webhooks/canal-da-instalacao/route.ts": "org resolvida pela assinatura do webhook",
};

const MENCIONA_ORG = /organization_id|organizationId|orgId/;

function rotas(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...rotas(caminho));
    else if (nome === "route.ts") saida.push(caminho);
  }
  return saida;
}

const comAdmin = rotas(join(RAIZ, "app", "api"))
  .map((abs) => ({
    rel: relative(RAIZ, abs).split(sep).join("/"),
    texto: readFileSync(abs, "utf8"),
  }))
  .filter(({ texto }) => texto.includes("createAdminClient"));

describe("rotas com service role tratam da organização", () => {
  it("a varredura enxerga as rotas (o instrumento está vivo)", () => {
    expect(comAdmin.length).toBeGreaterThan(100);
  });

  it("toda rota com createAdminClient menciona a organização ou está nas exceções", () => {
    const faltando = comAdmin
      .filter(({ rel, texto }) => !MENCIONA_ORG.test(texto) && !(rel in EXCECOES))
      .map(({ rel }) => rel);
    expect(faltando).toEqual([]);
  });

  it("a lista de exceções só encolhe: nenhuma entrada sobra", () => {
    const porCaminho = new Map(comAdmin.map((r) => [r.rel, r.texto]));
    const sobrando = Object.keys(EXCECOES).filter((rel) => {
      const texto = porCaminho.get(rel);
      return texto === undefined || MENCIONA_ORG.test(texto);
    });
    expect(sobrando).toEqual([]);
  });
});
