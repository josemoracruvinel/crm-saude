import { describe, expect, it } from "vitest";

import { destinoDoProntuario } from "./destino";

describe("destinoDoProntuario", () => {
  it("aceita endereço https completo", () => {
    expect(destinoDoProntuario(" https://prontuario.exemplo.com.br ")).toBe(
      "https://prontuario.exemplo.com.br/",
    );
  });

  it("recusa vazio, http e texto que não é endereço", () => {
    expect(destinoDoProntuario("")).toBeNull();
    expect(destinoDoProntuario(null)).toBeNull();
    expect(destinoDoProntuario("http://prontuario.exemplo.com.br")).toBeNull();
    expect(destinoDoProntuario("javascript:alert(1)")).toBeNull();
    expect(destinoDoProntuario("prontuario.exemplo.com.br")).toBeNull();
  });
});
