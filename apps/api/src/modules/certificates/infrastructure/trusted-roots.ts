import type { X509Certificate } from 'node:crypto';

/** The PSC trusted-roots configuration is missing or unusable; the operator CLI fails closed. */
export class TrustedRootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedRootsError';
  }
}

/** Parses a PEM bundle of PSC root certificates. */
export function parseTrustedRoots(_pem: string): X509Certificate[] {
  throw new TrustedRootsError('not implemented');
}

/** Loads the bundle named by `PSC_TRUSTED_ROOTS_PATH`. */
export function loadTrustedRoots(
  _env: NodeJS.ProcessEnv,
  _readFile: (path: string) => string,
): X509Certificate[] {
  throw new TrustedRootsError('not implemented');
}
