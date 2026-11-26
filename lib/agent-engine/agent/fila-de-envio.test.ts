import { describe, expect, it } from "vitest";

import { criarFilaDeEnvio } from "./fila-de-envio";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("criarFilaDeEnvio", () => {
  it("entrega na ordem de chamada mesmo quando a primeira tarefa é a mais lenta", async () => {
    const naOrdem = criarFilaDeEnvio();
    const saida: string[] = [];
    // Como no defeito medido: a abertura demora mais (mais conferências) que as outras.
    const chamadas = [
      naOrdem(async () => {
        await esperar(30);
        saida.push("Boa notícia, consegui ver a agenda");
      }),
      naOrdem(async () => {
        await esperar(5);
        saida.push("Tenho horário às 8h ou às 9h");
      }),
      naOrdem(async () => {
        await esperar(1);
        saida.push("Me manda seu nome completo");
      }),
    ];
    await Promise.all(chamadas);
    expect(saida).toEqual([
      "Boa notícia, consegui ver a agenda",
      "Tenho horário às 8h ou às 9h",
      "Me manda seu nome completo",
    ]);
  });

  it("sem a fila, a mesma corrida inverte a ordem (controle do teste acima)", async () => {
    const saida: string[] = [];
    await Promise.all([
      (async () => {
        await esperar(30);
        saida.push("abertura");
      })(),
      (async () => {
        await esperar(5);
        saida.push("horários");
      })(),
    ]);
    expect(saida).toEqual(["horários", "abertura"]);
  });

  it("uma tarefa só começa quando a anterior terminou", async () => {
    const naOrdem = criarFilaDeEnvio();
    let rodando = 0;
    let maximo = 0;
    const tarefa = () =>
      naOrdem(async () => {
        rodando += 1;
        maximo = Math.max(maximo, rodando);
        await esperar(5);
        rodando -= 1;
      });
    await Promise.all([tarefa(), tarefa(), tarefa()]);
    expect(maximo).toBe(1);
  });

  it("um erro volta para quem chamou e não trava as tarefas seguintes", async () => {
    const naOrdem = criarFilaDeEnvio();
    const primeira = naOrdem(async () => {
      throw new Error("vetado");
    });
    const segunda = naOrdem(async () => "enviada");
    await expect(primeira).rejects.toThrow("vetado");
    await expect(segunda).resolves.toBe("enviada");
  });

  it("devolve o resultado de cada tarefa a quem a chamou", async () => {
    const naOrdem = criarFilaDeEnvio();
    const [a, b] = await Promise.all([naOrdem(async () => 1), naOrdem(async () => "dois")]);
    expect(a).toBe(1);
    expect(b).toBe("dois");
  });
});
