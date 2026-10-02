import type { Ambiente } from '../emission-ports.ts';
import type { SifenOperation } from '../port.ts';

export type SifenEndpoints = Readonly<Record<SifenOperation, string>>;

const HOSTS: Readonly<Record<Ambiente, string>> = {
  test: 'https://sifen-test.set.gov.py',
  prod: 'https://sifen.set.gov.py',
};

/**
 * Service paths from Manual Técnico v150 §7.10 (WSDL addresses, without the `?wsdl` query).
 * Whether the SOAP POST goes to the `.wsdl` address itself is to be confirmed in sifen-test.
 */
const PATHS: Readonly<Record<SifenOperation, string>> = {
  enviarLote: '/de/ws/async/recibe-lote.wsdl',
  consultarLote: '/de/ws/consultas/consulta-lote.wsdl',
  enviarDESincronico: '/de/ws/sync/recibe.wsdl',
  consultarDE: '/de/ws/consultas/consulta.wsdl',
  enviarEventos: '/de/ws/eventos/evento.wsdl',
  consultarRUC: '/de/ws/consultas/consulta-ruc.wsdl',
};

/**
 * Endpoint URL per operation for an environment, with optional per-operation overrides.
 * @throws RangeError when an override is not an `https:` URL: mutual TLS is mandatory (MT §7.4)
 */
export function sifenEndpoints(
  ambiente: Ambiente,
  overrides: Partial<Record<SifenOperation, string>> = {},
): SifenEndpoints {
  const endpoints = { ...PATHS };
  for (const operation of Object.keys(PATHS) as SifenOperation[]) {
    endpoints[operation] = overrides[operation] ?? `${HOSTS[ambiente]}${PATHS[operation]}`;
    if (!endpoints[operation].startsWith('https://')) {
      throw new RangeError(`Endpoint for "${operation}" must use https`);
    }
  }
  return endpoints;
}
