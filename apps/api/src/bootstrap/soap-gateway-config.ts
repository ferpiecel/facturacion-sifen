/** Invalid SOAP gateway configuration; the message names the variable, never its value's secrets. */
export class SoapGatewayConfigError extends Error {
  readonly name = 'SoapGatewayConfigError';
}

export interface SoapGatewayConfig {
  /** Whole-call deadline; the transport default (30 s) when unset. */
  readonly timeoutMs?: number;
  /** `SIFEN_SOAP_ALLOW_PRODUCTION=true`: production tenants may reach SIFEN. */
  readonly allowProduction: boolean;
  /** PEM bundle from `SIFEN_SOAP_CA_FILE` (DNIT CA); replaces the default roots. */
  readonly trustedRoots?: string;
  /** `SIFEN_TLS_MAX_VERSION`: highest TLS version offered; the transport default (TLSv1.2) when unset. */
  readonly maxTlsVersion?: 'TLSv1.2' | 'TLSv1.3';
}

const MAX_TIMEOUT_MS = 120_000;

/**
 * Reads and validates the settings of `SIFEN_GATEWAY=soap` at startup, so a bad value stops the
 * process instead of surfacing on the first transmission. Production is opt-in (default off).
 * @throws SoapGatewayConfigError
 */
export function loadSoapGatewayConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): SoapGatewayConfig {
  const rawTimeout = env.SIFEN_SOAP_TIMEOUT_MS;
  let timeoutMs: number | undefined;
  if (rawTimeout !== undefined && rawTimeout !== '') {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new SoapGatewayConfigError(
        `SIFEN_SOAP_TIMEOUT_MS must be an integer between 1 and ${String(MAX_TIMEOUT_MS)}`,
      );
    }
  }
  const rawProduction = env.SIFEN_SOAP_ALLOW_PRODUCTION;
  if (
    rawProduction !== undefined &&
    rawProduction !== '' &&
    !['true', 'false'].includes(rawProduction)
  ) {
    throw new SoapGatewayConfigError('SIFEN_SOAP_ALLOW_PRODUCTION must be "true" or "false"');
  }
  const rawTls = env.SIFEN_TLS_MAX_VERSION;
  if (rawTls !== undefined && rawTls !== '' && rawTls !== 'TLSv1.2' && rawTls !== 'TLSv1.3') {
    throw new SoapGatewayConfigError('SIFEN_TLS_MAX_VERSION must be "TLSv1.2" or "TLSv1.3"');
  }
  let trustedRoots: string | undefined;
  const caFile = env.SIFEN_SOAP_CA_FILE;
  if (caFile !== undefined && caFile !== '') {
    try {
      trustedRoots = readFile(caFile);
    } catch {
      throw new SoapGatewayConfigError('SIFEN_SOAP_CA_FILE could not be read');
    }
    if (!trustedRoots.includes('-----BEGIN CERTIFICATE-----')) {
      throw new SoapGatewayConfigError('SIFEN_SOAP_CA_FILE holds no PEM certificate');
    }
  }
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    allowProduction: rawProduction === 'true',
    ...(trustedRoots === undefined ? {} : { trustedRoots }),
    ...(rawTls === 'TLSv1.2' || rawTls === 'TLSv1.3' ? { maxTlsVersion: rawTls } : {}),
  };
}
