import type { Database } from '@sifen/db';
import type { CertificateSource, CscSource } from '../application/ports/signing.port.js';

/** Minimal view of `CertificateVault` the signing flow needs. */
export interface CertificateOpener {
  open(
    db: Database,
    tenantId: string,
    environment: 'test' | 'production',
  ): Promise<{ p12: Buffer; password: string }>;
}

/** Minimal view of `CscVault` the signing flow needs. */
export interface CscOpener {
  getPlaintext(
    db: Database,
    tenantId: string,
    environment: 'test' | 'production',
    idCsc: string,
  ): Promise<Buffer>;
}

/** `CertificateSource` over the certificate vault: the tenant's active certificate, in memory only. */
export function createCertificateSource(_deps: {
  db: Database;
  vault: CertificateOpener;
}): CertificateSource {
  return { open: () => Promise.reject(new Error('not implemented')) };
}

/**
 * `CscSource` over the CSC vault. A tenant may hold two CSCs per environment (slots 1 and 2); the
 * lowest slot is used until a rotation policy says otherwise.
 */
export function createCscSource(_deps: { db: Database; vault: CscOpener }): CscSource {
  return { get: () => Promise.reject(new Error('not implemented')) };
}
