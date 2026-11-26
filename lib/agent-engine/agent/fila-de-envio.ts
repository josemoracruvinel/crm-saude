/**
 * FILA DE ENVIO DO TURNO — as mensagens saem na ordem em que o modelo as escreveu.
 *
 * O modelo pode pedir vários `send_message` num MESMO passo, e o SDK executa
 * essas chamadas juntas. Cada envio passa por consultas e pela cadeia de
 * guardrails antes de chegar ao canal, e esse caminho não tem duração fixa:
 * quem termina primeiro sai primeiro. Medido em produção (25/11/2026): o modelo
 * escreveu "Boa notícia, consegui ver a agenda", depois os horários, depois o
 * pedido de nome — e o cliente recebeu a abertura por ÚLTIMO, porque ela passou
 * por mais conferências que as outras duas.
 *
 * A trava anti-ban do número já serializa o envio físico, mas a ordem em que
 * cada chamada CHEGA a ela é a da corrida. Esta fila põe as chamadas em
 * sequência desde a entrada: a segunda só começa quando a primeira terminou
 * (enviada, vetada ou com erro). O SDK inicia as execuções na ordem das tool
 * calls do passo, então a ordem da fila é a do modelo.
 *
 * Uma chamada que falha não trava as seguintes: a cauda engole o erro, e quem
 * chamou recebe o próprio resultado (ou a própria exceção) intacto.
 */
export type FilaDeEnvio = <T>(tarefa: () => Promise<T>) => Promise<T>;

export function criarFilaDeEnvio(): FilaDeEnvio {
  let cauda: Promise<unknown> = Promise.resolve();
  return <T>(tarefa: () => Promise<T>): Promise<T> => {
    const vez = cauda.then(tarefa);
    cauda = vez.catch(() => undefined);
    return vez;
  };
}
