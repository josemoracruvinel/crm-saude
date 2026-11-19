/**
 * Fluxo Care — para onde a porta "Prontuário" do menu leva.
 *
 * Só endereço https completo vira destino; vazio ou qualquer outra coisa é
 * "não ligado" (a página mostra o aviso em vez de redirecionar para o nada).
 */
export function destinoDoProntuario(valor: string | null | undefined): string | null {
  const texto = (valor ?? "").trim();
  if (!texto) return null;
  try {
    const url = new URL(texto);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
