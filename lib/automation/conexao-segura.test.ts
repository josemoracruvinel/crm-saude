/**
 * `comConexaoSegura` — o IP é julgado no instante da conexão (DNS rebinding).
 *
 * Prova com rede de verdade: um servidor HTTP em 127.0.0.1 e o nome
 * `localhost`, que RESOLVE para ele. É exatamente o que um DNS hostil faz no
 * rebinding — entrega um endereço interno na hora de conectar. O controle
 * mostra que, sem o despachante, a mesma chamada chega ao servidor; então a
 * recusa é do despachante, não de outra coisa.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { comConexaoSegura, lookupSeguro } from "./conexao-segura";

let servidor: Server;
let porta = 0;
let chegaram = 0;

beforeAll(async () => {
  servidor = createServer((_req, res) => {
    chegaram++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  porta = (servidor.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
});

describe("lookupSeguro", () => {
  it("recusa nome que resolve para endereço interno (forma com all: true)", async () => {
    const erro = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookupSeguro("localhost", { all: true }, (err) => resolve(err)),
    );
    expect(erro?.code).toBe("EUNSAFEDEST");
    expect(erro?.message).toBe("unsafe_url:private_ip");
  });

  it("recusa também na forma sem all (um endereço só)", async () => {
    const erro = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookupSeguro("localhost", {}, (err) => resolve(err)),
    );
    expect(erro?.code).toBe("EUNSAFEDEST");
  });
});

describe("fetch com comConexaoSegura", () => {
  it("controle: sem o despachante, localhost chega ao servidor", async () => {
    const antes = chegaram;
    const res = await fetch(`http://localhost:${porta}/`);
    expect(await res.text()).toBe("ok");
    expect(chegaram).toBe(antes + 1);
  });

  it("com o despachante, localhost é recusado na conexão e nada chega ao servidor", async () => {
    const antes = chegaram;
    const erro = await fetch(`http://localhost:${porta}/`, comConexaoSegura({})).then(
      () => null,
      (e: unknown) => e as Error & { cause?: NodeJS.ErrnoException },
    );
    expect(erro).not.toBeNull();
    expect(erro?.cause?.code).toBe("EUNSAFEDEST");
    expect(chegaram).toBe(antes);
  });
});
