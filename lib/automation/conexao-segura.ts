/**
 * Conexão de saída que julga o IP NO INSTANTE DA CONEXÃO — fecha a janela do
 * DNS rebinding que `assertDestinoResolvidoSeguro` (outbound-ip.ts) declarava.
 *
 * O pré-check resolve o nome e decide; depois o `fetch` resolve DE NOVO para
 * conectar, e entre as duas resoluções um DNS hostil pode trocar a resposta por
 * 127.0.0.1 ou 169.254.169.254. Aqui o `lookup` do próprio socket faz o
 * julgamento: o endereço conferido é exatamente o endereço conectado.
 *
 * Só o `lookup` muda. O nome continua sendo o do destino para SNI, certificado
 * e cabeçalho Host — por isso não quebra TLS, que era o receio declarado em
 * outbound-ip.ts. Literal de IP não passa por `lookup` (o Node conecta direto);
 * esse caso continua coberto pelo pré-check, que segue em todos os chamadores.
 *
 * Use só onde o destino veio de fora (URL de tenant, provedor, site): nunca em
 * chamada para serviço interno autorizado, que esta conexão recusaria.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";

import { Agent, type Dispatcher } from "undici";

import { ipEhEspecial } from "@/lib/automation/outbound-ip";

type Callback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function erroInseguro(motivo: string): NodeJS.ErrnoException {
  const erro: NodeJS.ErrnoException = new Error(`unsafe_url:${motivo}`);
  erro.code = "EUNSAFEDEST";
  return erro;
}

/**
 * `lookup` compatível com `net.connect`: resolve TODOS os endereços e recusa se
 * QUALQUER um cair em faixa especial (mesma regra do pré-check). Atende às duas
 * formas de chamada do Node — com `all: true` (autoSelectFamily) e sem.
 */
export function lookupSeguro(hostname: string, options: LookupOptions, callback: Callback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, enderecos) => {
    if (err) return callback(err, []);
    const lista = enderecos as LookupAddress[];
    if (lista.length === 0) return callback(erroInseguro("dns_empty"), []);
    for (const { address } of lista) {
      if (ipEhEspecial(address)) return callback(erroInseguro("private_ip"), []);
    }
    if (options.all) return callback(null, lista);
    const primeiro = lista[0]!;
    callback(null, primeiro.address, primeiro.family);
  });
}

let agente: Dispatcher | null = null;

/** O despachante compartilhado (uma piscina de conexões para toda a saída). */
export function despachanteSeguro(): Dispatcher {
  agente ??= new Agent({ connect: { lookup: lookupSeguro } });
  return agente;
}

/**
 * Acrescenta o despachante seguro às opções de um `fetch`. O tipo do DOM não
 * conhece `dispatcher`, mas o `fetch` do Node aceita — e um `fetch` falso de
 * teste simplesmente o ignora.
 */
export function comConexaoSegura<T extends RequestInit>(init: T): T {
  return { ...init, dispatcher: despachanteSeguro() } as T;
}
