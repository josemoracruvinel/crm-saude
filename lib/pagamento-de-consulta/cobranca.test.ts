import { describe, expect, it, vi } from "vitest";

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

import { linkSeguro, situacaoDoAsaas, type AsaasDaClinica, type CobrancaLida } from "./asaas";
import {
  cobrarConsulta,
  processarPagamento,
  vencimentoDaCobranca,
  type CobrancaGuardada,
  type CobrarDeps,
  type ConsultaDaCobranca,
  type ProcessarDeps,
} from "./cobranca";
import { hashDoToken, tokenConfere, urlDoAviso } from "./conexao";

const AGORA = new Date("2026-11-26T15:00:00Z"); // 12h em São Paulo

function consulta(p: Partial<ConsultaDaCobranca> = {}): ConsultaDaCobranca {
  return {
    status: "pending",
    contact_id: "ct-1",
    conversation_id: "cv-1",
    event_type_id: "tp-1",
    starts_at: "2026-11-28T14:00:00Z",
    time_zone: "America/Sao_Paulo",
    title: "Teleconsulta por vídeo",
    ...p,
  };
}

function lida(p: Partial<CobrancaLida> = {}): CobrancaLida {
  return { id: "pay_1", situacao: "pendente", link: "https://sandbox.asaas.com/i/abc", vencimento: "2026-11-27", referencia: "ap-1", valorCents: 12000, ...p };
}

function asaasDublado(p: { cobranca?: CobrancaLida; garantir?: () => Promise<string> } = {}) {
  return {
    modo: "teste",
    testar: vi.fn(),
    cadastrarAviso: vi.fn(),
    removerAviso: vi.fn(),
    garantirCliente: vi.fn(p.garantir ?? (async () => "cus_1")),
    criarCobranca: vi.fn(async () => p.cobranca ?? lida()),
    lerCobranca: vi.fn(async () => p.cobranca ?? lida()),
    cancelarCobranca: vi.fn(async () => undefined),
  } as unknown as AsaasDaClinica & Record<string, ReturnType<typeof vi.fn>>;
}

function depsDeCobrar(p: {
  conectada?: boolean;
  consulta?: ConsultaDaCobranca | null;
  preco?: number | null;
  viva?: CobrancaGuardada | null;
  cliente?: string | null;
  insere?: boolean;
  asaas?: ReturnType<typeof asaasDublado>;
} = {}) {
  const asaas = p.asaas ?? asaasDublado();
  const deps = {
    conexao: vi.fn(async () => (p.conectada === false ? null : { asaas, modo: "teste" as const })),
    consulta: vi.fn(async () => (p.consulta === undefined ? consulta() : p.consulta)),
    precoDoTipo: vi.fn(async () => (p.preco === undefined ? 12000 : p.preco)),
    cobrancaViva: vi.fn(async () => p.viva ?? null),
    clienteGuardado: vi.fn(async () => (p.cliente === undefined ? null : p.cliente)),
    guardaCliente: vi.fn(async () => undefined),
    nomeDoContato: vi.fn(async () => "Maria Teste"),
    guardaCpfNaFicha: vi.fn(async () => undefined),
    prazoDaReservaMinutos: vi.fn(async () => 1440),
    insereCobranca: vi.fn(async () => p.insere ?? true),
    clock: () => AGORA,
  } satisfies CobrarDeps;
  return { deps, asaas };
}

const ENTRADA = { organizationId: "org-1", appointmentId: "ap-1" };

describe("cobrarConsulta", () => {
  it("primeira cobrança do paciente: cria o cliente com o CPF, cria a cobrança e devolve o link", async () => {
    const { deps, asaas } = depsDeCobrar();
    const r = await cobrarConsulta(deps, { ...ENTRADA, cpf: "529.982.247-25" });
    expect(r).toMatchObject({ ok: true, link: "https://sandbox.asaas.com/i/abc", valor_cents: 12000, ja_existia: false });
    expect(asaas.garantirCliente).toHaveBeenCalledWith({ nome: "Maria Teste", cpf: "52998224725", referencia: "ct-1" });
    expect(deps.guardaCliente).toHaveBeenCalledWith("org-1", "ct-1", "teste", "cus_1");
    expect(deps.guardaCpfNaFicha).toHaveBeenCalledWith("org-1", "ct-1", "52998224725");
    expect(asaas.criarCobranca).toHaveBeenCalledWith(
      expect.objectContaining({ cliente: "cus_1", valorCents: 12000, referencia: "ap-1", vencimento: "2026-11-27" }),
    );
  });

  it("sem CPF e sem cliente guardado: pede o CPF e não cria nada no Asaas", async () => {
    const { deps, asaas } = depsDeCobrar();
    expect(await cobrarConsulta(deps, ENTRADA)).toEqual({ ok: false, motivo: "cpf_necessario" });
    expect(asaas.garantirCliente).not.toHaveBeenCalled();
    expect(asaas.criarCobranca).not.toHaveBeenCalled();
  });

  it("paciente que já pagou antes: reaproveita o cliente e não pede o CPF de novo", async () => {
    const { deps, asaas } = depsDeCobrar({ cliente: "cus_antigo" });
    const r = await cobrarConsulta(deps, ENTRADA);
    expect(r.ok).toBe(true);
    expect(asaas.garantirCliente).not.toHaveBeenCalled();
    expect(asaas.criarCobranca).toHaveBeenCalledWith(expect.objectContaining({ cliente: "cus_antigo" }));
  });

  it("chamar de novo para a mesma consulta devolve o MESMO link, sem cobrar outra vez", async () => {
    const viva: CobrancaGuardada = {
      id: "cp-1",
      provider_payment_id: "pay_1",
      appointment_id: "ap-1",
      situacao: "pendente",
      link: "https://sandbox.asaas.com/i/abc",
      valor_cents: 12000,
      vencimento: "2026-11-27",
      confirmou_consulta: false,
    };
    const { deps, asaas } = depsDeCobrar({ viva });
    expect(await cobrarConsulta(deps, { ...ENTRADA, cpf: "52998224725" })).toMatchObject({ ok: true, ja_existia: true, link: viva.link });
    expect(asaas.criarCobranca).not.toHaveBeenCalled();
  });

  it("corrida perdida: a cobrança recém-criada sai do Asaas e vale a da outra chamada", async () => {
    const viva: CobrancaGuardada = {
      id: "cp-0",
      provider_payment_id: "pay_0",
      appointment_id: "ap-1",
      situacao: "pendente",
      link: "https://sandbox.asaas.com/i/vencedora",
      valor_cents: 12000,
      vencimento: "2026-11-27",
      confirmou_consulta: false,
    };
    const { deps, asaas } = depsDeCobrar({ cliente: "cus_1", insere: false });
    deps.cobrancaViva.mockResolvedValueOnce(null).mockResolvedValueOnce(viva);
    const r = await cobrarConsulta(deps, ENTRADA);
    expect(asaas.cancelarCobranca).toHaveBeenCalledWith("pay_1");
    expect(r).toMatchObject({ ok: true, link: viva.link, ja_existia: true });
  });

  it("recusas que não tocam o Asaas: sem conexão, sem preço, consulta cancelada, sem paciente", async () => {
    expect(await cobrarConsulta(depsDeCobrar({ conectada: false }).deps, ENTRADA)).toEqual({ ok: false, motivo: "sem_conexao" });
    expect(await cobrarConsulta(depsDeCobrar({ preco: null, cliente: "c" }).deps, ENTRADA)).toEqual({ ok: false, motivo: "sem_preco" });
    expect(await cobrarConsulta(depsDeCobrar({ consulta: consulta({ status: "cancelled" }) }).deps, ENTRADA)).toEqual({
      ok: false,
      motivo: "consulta_cancelada",
    });
    expect(await cobrarConsulta(depsDeCobrar({ consulta: consulta({ contact_id: null }) }).deps, ENTRADA)).toEqual({
      ok: false,
      motivo: "sem_contato",
    });
    expect(await cobrarConsulta(depsDeCobrar({ consulta: null }).deps, ENTRADA)).toEqual({ ok: false, motivo: "consulta_inexistente" });
  });

  it("CPF que o Asaas recusa vira pedido de conferir os números", async () => {
    const asaas = asaasDublado({
      garantir: async () => {
        throw new ErroDoProvedor(null, "documento_invalido", false);
      },
    });
    const { deps } = depsDeCobrar({ asaas });
    expect(await cobrarConsulta(deps, { ...ENTRADA, cpf: "111" })).toEqual({ ok: false, motivo: "cpf_invalido" });
  });
});

describe("vencimentoDaCobranca", () => {
  it("acompanha o prazo da reserva, nunca passa do dia da consulta, nunca antes de hoje", () => {
    expect(vencimentoDaCobranca(AGORA, 1440, "2026-11-30T14:00:00Z")).toBe("2026-11-27");
    expect(vencimentoDaCobranca(AGORA, 7 * 1440, "2026-11-28T14:00:00Z")).toBe("2026-11-28");
    expect(vencimentoDaCobranca(AGORA, 60, "2026-11-26T20:00:00Z")).toBe("2026-11-26");
    expect(vencimentoDaCobranca(AGORA, 1440, "2026-11-20T14:00:00Z")).toBe("2026-11-26");
  });
});

function guardada(p: Partial<CobrancaGuardada> = {}): CobrancaGuardada {
  return {
    id: "cp-1",
    provider_payment_id: "pay_1",
    appointment_id: "ap-1",
    situacao: "pendente",
    link: "https://sandbox.asaas.com/i/abc",
    valor_cents: 12000,
    vencimento: "2026-11-27",
    confirmou_consulta: false,
    ...p,
  };
}

function depsDeProcessar(p: {
  conectada?: boolean;
  guardada?: CobrancaGuardada | null;
  lida?: CobrancaLida;
  consulta?: ConsultaDaCobranca | null;
  confirma?: boolean;
  marca?: boolean;
} = {}) {
  const asaas = asaasDublado({ cobranca: p.lida ?? lida({ situacao: "pago" }) });
  const deps = {
    conexao: vi.fn(async () => (p.conectada === false ? null : { asaas })),
    cobrancaPorId: vi.fn(async () => (p.guardada === undefined ? guardada() : p.guardada)),
    atualizaCobranca: vi.fn(async () => undefined),
    consulta: vi.fn(async () => (p.consulta === undefined ? consulta() : p.consulta)),
    confirmaConsulta: vi.fn(async () => p.confirma ?? true),
    marcaQueConfirmou: vi.fn(async () => p.marca ?? true),
    avisaPaciente: vi.fn(async () => undefined),
    avisaEquipe: vi.fn(async () => undefined),
    clock: () => AGORA,
  } satisfies ProcessarDeps;
  return { deps, asaas };
}

const AVISO = { organizationId: "org-1", providerPaymentId: "pay_1" };

describe("processarPagamento", () => {
  it("pagou e a consulta está reservada: confirma, marca e avisa o paciente", async () => {
    const { deps, asaas } = depsDeProcessar();
    expect(await processarPagamento(deps, AVISO)).toBe("confirmou");
    expect(asaas.lerCobranca).toHaveBeenCalledWith("pay_1");
    expect(deps.atualizaCobranca).toHaveBeenCalledWith("org-1", "cp-1", expect.objectContaining({ situacao: "pago" }), AGORA.toISOString());
    expect(deps.confirmaConsulta).toHaveBeenCalledWith("org-1", "ap-1");
    expect(deps.avisaPaciente).toHaveBeenCalledTimes(1);
  });

  it("a decisão vem da releitura: aviso de pagamento com a cobrança ainda pendente não confirma", async () => {
    const { deps } = depsDeProcessar({ lida: lida({ situacao: "pendente" }) });
    expect(await processarPagamento(deps, AVISO)).toBe("registrado");
    expect(deps.confirmaConsulta).not.toHaveBeenCalled();
  });

  it("aviso repetido depois de confirmar: só registra, não avisa o paciente de novo", async () => {
    const { deps } = depsDeProcessar({ guardada: guardada({ situacao: "pago", confirmou_consulta: true }) });
    expect(await processarPagamento(deps, AVISO)).toBe("registrado");
    expect(deps.confirmaConsulta).not.toHaveBeenCalled();
    expect(deps.avisaPaciente).not.toHaveBeenCalled();
  });

  it("dois avisos ao mesmo tempo: só quem gravou a marca avisa o paciente", async () => {
    const { deps } = depsDeProcessar({ marca: false });
    expect(await processarPagamento(deps, AVISO)).toBe("confirmou");
    expect(deps.avisaPaciente).not.toHaveBeenCalled();
  });

  it("pagou depois que a reserva expirou: não confirma nada e avisa a equipe", async () => {
    const { deps } = depsDeProcessar({ consulta: consulta({ status: "cancelled" }) });
    expect(await processarPagamento(deps, AVISO)).toBe("pago_sem_reserva");
    expect(deps.confirmaConsulta).not.toHaveBeenCalled();
    expect(deps.avisaEquipe).toHaveBeenCalledWith("org-1", "ap-1", "pago_sem_reserva");
  });

  it("consulta que já estava confirmada: não mexe nela, mas avisa o paciente que o pagamento caiu", async () => {
    // Medido em 26/11/2026: a IA cobrou uma consulta já confirmada e prometeu
    // "eu te aviso por aqui" — sem o aviso, a promessa ficava sem cumprir.
    const { deps } = depsDeProcessar({ consulta: consulta({ status: "confirmed" }) });
    expect(await processarPagamento(deps, AVISO)).toBe("ja_confirmada");
    expect(deps.confirmaConsulta).not.toHaveBeenCalled();
    expect(deps.marcaQueConfirmou).toHaveBeenCalledWith("org-1", "cp-1");
    expect(deps.avisaPaciente).toHaveBeenCalledTimes(1);
  });

  it("consulta já confirmada e aviso repetido do Asaas: o paciente não recebe duas vezes", async () => {
    const { deps } = depsDeProcessar({ consulta: consulta({ status: "confirmed" }), marca: false });
    expect(await processarPagamento(deps, AVISO)).toBe("ja_confirmada");
    expect(deps.avisaPaciente).not.toHaveBeenCalled();
  });

  it("consulta que já aconteceu (ou faltou): só registra o pagamento", async () => {
    const { deps } = depsDeProcessar({ consulta: consulta({ status: "completed" }) });
    expect(await processarPagamento(deps, AVISO)).toBe("registrado");
    expect(deps.confirmaConsulta).not.toHaveBeenCalled();
    expect(deps.avisaPaciente).not.toHaveBeenCalled();
  });

  it("cobrança feita à mão no painel do Asaas, ou clínica sem conexão: não é nossa", async () => {
    expect(await processarPagamento(depsDeProcessar({ guardada: null }).deps, AVISO)).toBe("cobranca_desconhecida");
    expect(await processarPagamento(depsDeProcessar({ conectada: false }).deps, AVISO)).toBe("sem_conexao");
  });
});

describe("Asaas e conexão", () => {
  it("traduz as situações do Asaas para as nossas", () => {
    expect(situacaoDoAsaas("RECEIVED", false)).toBe("pago");
    expect(situacaoDoAsaas("CONFIRMED", false)).toBe("pago");
    expect(situacaoDoAsaas("OVERDUE", false)).toBe("vencido");
    expect(situacaoDoAsaas("REFUNDED", false)).toBe("estornado");
    expect(situacaoDoAsaas("PENDING", true)).toBe("cancelado");
    expect(situacaoDoAsaas("ALGO_NOVO", false)).toBe("pendente");
  });

  it("só link https sai para o paciente", () => {
    expect(linkSeguro("https://www.asaas.com/i/1")).toBe("https://www.asaas.com/i/1");
    expect(linkSeguro("javascript:alert(1)")).toBeNull();
    expect(linkSeguro("http://www.asaas.com/i/1")).toBeNull();
  });

  it("o token do aviso confere pelo hash, e só ele", () => {
    const hash = hashDoToken("segredo-do-aviso");
    expect(tokenConfere("segredo-do-aviso", hash)).toBe(true);
    expect(tokenConfere("outro", hash)).toBe(false);
    expect(tokenConfere(null, hash)).toBe(false);
    expect(tokenConfere("segredo-do-aviso", null)).toBe(false);
  });

  it("o aviso só é cadastrado com endereço https público", () => {
    expect(urlDoAviso("https://app.aloclin.com.br/", "c1")).toBe(
      "https://app.aloclin.com.br/api/v1/webhooks/pagamento-de-consulta/asaas/c1",
    );
    expect(urlDoAviso("http://localhost:3000", "c1")).toBeNull();
  });
});
