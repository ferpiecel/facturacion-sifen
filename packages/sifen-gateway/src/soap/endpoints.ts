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

export interface EndpointOptions {
  /**
   * Lets overrides point at a host other than the official one of the environment. For tests only:
   * never derive it from configuration or request data.
   */
  readonly allowCustomHost?: boolean;
}

function checkOverride(
  operation: SifenOperation,
  value: string,
  ambiente: Ambiente,
  options: EndpointOptions,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new RangeError(`Endpoint for "${operation}" is not a valid URL`, { cause });
  }
  if (url.protocol !== 'https:') {
    throw new RangeError(`Endpoint for "${operation}" must use https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new RangeError(`Endpoint for "${operation}" must not carry credentials`);
  }
  if (options.allowCustomHost !== true && url.origin !== HOSTS[ambiente]) {
    throw new RangeError(
      `Endpoint for "${operation}" must be on ${HOSTS[ambiente]} for "${ambiente}"`,
    );
  }
}

/**
 * Endpoint URL per operation for an environment, with optional per-operation overrides. An override
 * must be an https URL on the official host of THAT environment, so `test` can never reach production
 * and vice versa, unless `allowCustomHost` is set explicitly (tests only).
 * @throws RangeError for an override that is not acceptable
 */
export function sifenEndpoints(
  ambiente: Ambiente,
  overrides: Partial<Record<SifenOperation, string>> = {},
  options: EndpointOptions = {},
): SifenEndpoints {
  const endpoints = { ...PATHS };
  for (const operation of Object.keys(PATHS) as SifenOperation[]) {
    const override = overrides[operation];
    if (override === undefined) {
      endpoints[operation] = `${HOSTS[ambiente]}${PATHS[operation]}`;
    } else {
      checkOverride(operation, override, ambiente, options);
      endpoints[operation] = override;
    }
  }
  return endpoints;
}
