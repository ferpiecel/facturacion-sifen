import type { X509Certificate } from 'node:crypto';
import type { Database } from '@sifen/db';
import type { EnvelopeCipher } from '../../custody/application/envelope-cipher.js';
import type { CertificateRejection } from '../domain/tenant-certificate.js';

type Environment = 'test' | 'production';

/** The certificate failed validation; carries every reason, never the file or its password. */
export class CertificateRejectedError extends Error {
  constructor(readonly rejections: readonly CertificateRejection[]) {
    super(`certificate rejected: ${rejections.map((r) => r.code).join(', ')}`);
    this.name = 'CertificateRejectedError';
  }
}

export class ActiveCertificateExistsError extends Error {
  constructor(environment: Environment) {
    super(`tenant already has an active certificate for ${environment}`);
    this.name = 'ActiveCertificateExistsError';
  }
}

export class CertificateNotFoundError extends Error {
  constructor(environment: Environment) {
    super(`no active certificate for ${environment}`);
    this.name = 'CertificateNotFoundError';
  }
}

export interface AddCertificateParams {
  readonly tenantId: string;
  readonly environment: Environment;
  readonly p12: Uint8Array;
  readonly password: string;
  /** Revokes the current active certificate in the same transaction instead of refusing. */
  readonly replace?: boolean;
}

export interface StoredCertificate {
  readonly id: string;
  readonly fingerprint: string;
  readonly subjectRuc: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/** A tenant certificate in memory; the caller owns it and should zeroize `p12`. Never log it. */
export interface OpenedCertificate {
  readonly p12: Buffer;
  readonly password: string;
  readonly fingerprint: string;
}

export interface CertificateVaultOptions {
  readonly trustedPscRoots: readonly X509Certificate[];
  readonly now?: () => Date;
}

export class CertificateVault {
  constructor(
    private readonly cipher: EnvelopeCipher,
    private readonly options: CertificateVaultOptions,
  ) {}

  add(_db: Database, _params: AddCertificateParams): Promise<StoredCertificate> {
    return Promise.reject(new Error('not implemented'));
  }

  open(_db: Database, _tenantId: string, _environment: Environment): Promise<OpenedCertificate> {
    return Promise.reject(new Error('not implemented'));
  }
}
