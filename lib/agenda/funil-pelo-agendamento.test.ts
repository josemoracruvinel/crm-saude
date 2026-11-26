import { describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { LeadStage } from "@/lib/agent-engine/agent/lead-state";
import type { ResultadoDaSincronizacao } from "@/lib/leads/agent-stage-sync";

import {
  type FunilPeloAgendamentoDeps,
  aplicaFunilPeloAgendamento,
  caminhoAte,
  passoDoAgendamento,
} from "./funil-pelo-agendamento";

describe("passoDoAgendamento", () => {
  it("horário reservado (pendente) é negociação; confirmado é ganho", () => {
    expect(passoDoAgendamento("appointment.created", "pending")).toBe("negotiating");
    expect(passoDoAgendamento("appointment.created", "confirmed")).toBe("won");
    expect(passoDoAgendamento("appointment.confirmed", "confirmed")).toBe("won");
  });

  it("cancelado antes do dreno, ou outro evento, não é notícia para o funil", () => {
    expect(passoDoAgendamento("appointment.created", "cancelled")).toBeNull();
    expect(passoDoAgendamento("appointment.confirmed", "cancelled")).toBeNull();
    expect(passoDoAgendamento("appointment.cancelled", "cancelled")).toBeNull();
    expect(passoDoAgendamento("appointment.rescheduled", "confirmed")).toBeNull();
  });
});

describe("caminhoAte", () => {
  it("anda passo a passo, sem pular", () => {
    expect(caminhoAte("qualifying", "won")).toEqual(["qualified", "negotiating", "won"]);
    expect(caminhoAte("new", "negotiating")).toEqual(["contacted", "qualifying", "qualified", "negotiating"]);
    expect(caminhoAte("negotiating", "won")).toEqual(["won"]);
  });

  it("nunca recua nem sai de um terminal", () => {
    expect(caminhoAte("won", "negotiating")).toEqual([]);
    expect(caminhoAte("lost", "won")).toEqual([]);
    expect(caminhoAte("won", "won")).toEqual([]);
    expect(caminhoAte("negotiating", "negotiating")).toEqual([]);
  });
});

function linha(evento: string, payload: Record<string, unknown> = { appointment_id: "ap-1" }): EventRow {
  return {
    id: "ev-1",
    organization_id: "org-1",
    event_type: evento,
    entity_kind: "calendar_appointment",
    entity_id: "ap-1",
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function dublar(opts: {
  agendamento?: { status: string; contact_id: string | null } | null;
  atual?: LeadStage | null;
  avancaOk?: boolean;
  card?: ResultadoDaSincronizacao["motivo"];
}) {
  const deps = {
    carregaAgendamento: vi.fn(async () =>
      opts.agendamento === undefined ? { status: "confirmed", contact_id: "ct-1" } : opts.agendamento,
    ),
    passoAtual: vi.fn(async () => (opts.atual === undefined ? "qualifying" : opts.atual)),
    avanca: vi.fn(async () => opts.avancaOk ?? true),
    moveCard: vi.fn(async () => ({
      moveu: (opts.card ?? "movido") === "movido",
      motivo: opts.card ?? "movido",
      stageName: "Consulta agendada",
    })),
    clock: () => new Date("2026-11-26T12:00:00Z"),
  } satisfies FunilPeloAgendamentoDeps;
  return deps;
}

describe("aplicaFunilPeloAgendamento", () => {
  it("consulta confirmada leva o atendimento de triagem a ganho e move o card", async () => {
    const deps = dublar({});
    const r = await aplicaFunilPeloAgendamento(deps, linha("appointment.created"));
    expect(deps.avanca).toHaveBeenCalledWith(
      "org-1",
      "ct-1",
      "qualifying",
      ["qualified", "negotiating", "won"],
      "horário confirmado na agenda",
    );
    expect(deps.moveCard).toHaveBeenCalledWith("org-1", "ct-1", "won");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("Consulta agendada");
  });

  it("horário reservado (aguarda confirmação) vai só até negociação", async () => {
    const deps = dublar({ agendamento: { status: "pending", contact_id: "ct-1" } });
    await aplicaFunilPeloAgendamento(deps, linha("appointment.created"));
    expect(deps.avanca).toHaveBeenCalledWith(
      "org-1",
      "ct-1",
      "qualifying",
      ["qualified", "negotiating"],
      "horário reservado na agenda",
    );
    expect(deps.moveCard).toHaveBeenCalledWith("org-1", "ct-1", "negotiating");
  });

  it("a equipe confirma depois do pagamento: de negociação para ganho", async () => {
    const deps = dublar({ atual: "negotiating" });
    await aplicaFunilPeloAgendamento(deps, linha("appointment.confirmed"));
    expect(deps.avanca).toHaveBeenCalledWith("org-1", "ct-1", "negotiating", ["won"], "horário confirmado na agenda");
    expect(deps.moveCard).toHaveBeenCalledWith("org-1", "ct-1", "won");
  });

  it("contato que o agente nunca atendeu começa do primeiro passo", async () => {
    const deps = dublar({ atual: null, agendamento: { status: "pending", contact_id: "ct-1" } });
    await aplicaFunilPeloAgendamento(deps, linha("appointment.created"));
    expect(deps.avanca).toHaveBeenCalledWith(
      "org-1",
      "ct-1",
      null,
      ["contacted", "qualifying", "qualified", "negotiating"],
      "horário reservado na agenda",
    );
  });

  it("quem já passou do destino não recua, e o card não é tocado", async () => {
    const deps = dublar({ atual: "won", agendamento: { status: "pending", contact_id: "ct-1" } });
    const r = await aplicaFunilPeloAgendamento(deps, linha("appointment.created"));
    expect(r.status).toBe("skipped");
    expect(deps.avanca).not.toHaveBeenCalled();
    expect(deps.moveCard).not.toHaveBeenCalled();
  });

  it("já no destino: não grava de novo, mas confere o card (retentativa)", async () => {
    const deps = dublar({ atual: "won" });
    const r = await aplicaFunilPeloAgendamento(deps, linha("appointment.confirmed"));
    expect(deps.avanca).not.toHaveBeenCalled();
    expect(deps.moveCard).toHaveBeenCalledWith("org-1", "ct-1", "won");
    expect(r.status).toBe("ok");
  });

  it("horário cancelado antes do dreno não mexe em nada", async () => {
    const deps = dublar({ agendamento: { status: "cancelled", contact_id: "ct-1" } });
    const r = await aplicaFunilPeloAgendamento(deps, linha("appointment.created"));
    expect(r).toMatchObject({ status: "skipped", detail: "agendamento_cancelled" });
    expect(deps.passoAtual).not.toHaveBeenCalled();
  });

  it("agendamento sem contato (ex.: veio do Google) é ignorado", async () => {
    const deps = dublar({ agendamento: { status: "confirmed", contact_id: null } });
    const r = await aplicaFunilPeloAgendamento(deps, linha("appointment.created"));
    expect(r).toMatchObject({ status: "skipped", detail: "sem_contato" });
  });

  it("outro escritor mudou o estado no meio: tenta de novo depois, sem mover o card", async () => {
    const deps = dublar({ avancaOk: false });
    const r = await aplicaFunilPeloAgendamento(deps, linha("appointment.created"));
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBe("2026-11-26T12:00:30.000Z");
    expect(deps.moveCard).not.toHaveBeenCalled();
  });

  it("banco fora ao mover o card é erro (o dreno tenta de novo); falta de mapeamento não é", async () => {
    expect((await aplicaFunilPeloAgendamento(dublar({ card: "indisponivel" }), linha("appointment.created"))).status).toBe("error");
    expect((await aplicaFunilPeloAgendamento(dublar({ card: "sem_mapeamento" }), linha("appointment.created"))).status).toBe("ok");
  });
});
