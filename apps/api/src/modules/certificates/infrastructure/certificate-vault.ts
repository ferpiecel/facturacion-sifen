import { createHash, type X509Certificate } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  tenantCertificates,
  tenantFiscalProfiles,
  tenants,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import type { EnvelopeCipher } from '../../custody/application/envelope-cipher.js';
import type { SealedSecret, SecretContext } from '../../custody/domain/sealed-secret.js';
import { createRuc, formatRuc } from '../../fiscal-config/domain/ruc.js';
import {
  validateTenantCertificate,
  type CertificateRejection,
} from '../domain/tenant-certificate.js';
import { inspectPkcs12 } from './pkcs12-inspector.js';

const CERTIFICATE_VERSION = 1;

type Environment = 'test' | 'production';

/** The certificate failed validation; carries every reason, never the file or its password. */
export class CertificateRejectedError extends Error {
  constructor(readonly rejections: readonly CertificateRejection[]) {
    super(`certificate rejected: ${rejections.map(describeRejection).join('; ')}`);
    this.name = 'CertificateRejectedError';
  }
}

function describeRejection(rejection: CertificateRejection): string {
  switch (rejection.code) {
    case 'ruc-mismatch':
      return `ruc-mismatch (tenant ${rejection.expected}, certificate ${rejection.actual ?? 'none'})`;
    case 'expired':
      return `expired (notAfter ${rejection.notAfter.toISOString()})`;
    case 'not-yet-valid':
      return `not-yet-valid (notBefore ${rejection.notBefore.toISOString()})`;
    default:
      return rejection.code;
  }
}

export class ActiveCertificateExistsError extends Error {
  constructor(environment: Environment) {
    super(`tenant already has an active certificate for ${environment}`);
    this.name = 'ActiveCertificateExistsError';
  }
}

/** The stored certificate is outside its validity window; signing with it would be rejected. */
export class CertificateValidityError extends Error {
  constructor(readonly reason: 'expired' | 'not-yet-valid') {
    super(`stored certificate is ${reason}`);
    this.name = 'CertificateValidityError';
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

/**
 * Custody of tenant `.p12` files (ADR-0009, ADR-0010, HU-E3-01): validated with the tenant's own
 * RUC and the configured PSC roots, sealed with {@link EnvelopeCipher} (the payload is the `.p12`
 * and its password), opened only in memory inside the tenant's RLS scope.
 */
export class CertificateVault {
  constructor(
    private readonly cipher: EnvelopeCipher,
    private readonly options: CertificateVaultOptions,
  ) {}

  private context(tenantId: string, environment: Environment, fingerprint: string): SecretContext {
    return {
      tenantId,
      kind: 'certificate',
      environment,
      version: CERTIFICATE_VERSION,
      label: fingerprint,
    };
  }

  /**
   * Operator path (owner connection).
   * @throws Pkcs12UnreadableError / Pkcs12ContentError when the file cannot be opened.
   * @throws CertificateRejectedError with every validation reason.
   * @throws ActiveCertificateExistsError unless `replace` is set.
   */
  async add(db: Database, params: AddCertificateParams): Promise<StoredCertificate> {
    const { tenantId, environment, p12, password, replace = false } = params;
    const tenant = (
      await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId))
    ).at(0);
    if (!tenant) throw new Error(`tenant not found: ${tenantId}`);
    const profile = (
      await db
        .select({ rucBase: tenantFiscalProfiles.rucBase, rucDv: tenantFiscalProfiles.rucDv })
        .from(tenantFiscalProfiles)
        .where(eq(tenantFiscalProfiles.tenantId, tenantId))
    ).at(0);
    if (!profile) throw new Error(`tenant has no fiscal profile: ${tenantId}`);

    const inspection = inspectPkcs12(p12, password);
    const rejections = validateTenantCertificate(inspection, {
      tenantRuc: createRuc(profile.rucBase, profile.rucDv),
      now: (this.options.now ?? (() => new Date()))(),
      trustedPscRoots: this.options.trustedPscRoots,
    });
    if (rejections.length > 0) throw new CertificateRejectedError(rejections);

    const fingerprint = createHash('sha256').update(inspection.certificate.raw).digest('hex');
    const payload = Buffer.from(
      JSON.stringify({ p12: Buffer.from(p12).toString('base64'), password }),
      'utf8',
    );
    let sealed: SealedSecret;
    try {
      sealed = await this.cipher.seal(payload, this.context(tenantId, environment, fingerprint));
    } finally {
      payload.fill(0);
    }

    const stored = {
      fingerprint,
      subjectRuc: inspection.subjectRuc ? formatRuc(inspection.subjectRuc) : '',
      notBefore: inspection.notBefore,
      notAfter: inspection.notAfter,
    };
    return db.transaction(async (tx) => {
      const active = await tx
        .select({ id: tenantCertificates.id })
        .from(tenantCertificates)
        .where(
          and(
            eq(tenantCertificates.tenantId, tenantId),
            eq(tenantCertificates.environment, environment),
            eq(tenantCertificates.status, 'active'),
          ),
        );
      if (active.length > 0) {
        if (!replace) throw new ActiveCertificateExistsError(environment);
        await tx
          .update(tenantCertificates)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(eq(tenantCertificates.id, active[0].id));
      }
      const [row] = await tx
        .insert(tenantCertificates)
        .values({ tenantId, environment, sealed, ...stored })
        .returning({ id: tenantCertificates.id });
      return { id: row.id, ...stored };
    });
  }

  /**
   * Decrypts the tenant's active certificate in memory; the caller owns the returned buffer and
   * should zeroize it. Never logged, never persisted.
   *
   * @throws CertificateNotFoundError when there is no active certificate.
   * @throws CertificateValidityError when it is expired or not yet valid at `now`.
   * @throws SecretDecryptionError when the stored blob does not match its row identity.
   */
  async open(db: Database, tenantId: string, environment: Environment): Promise<OpenedCertificate> {
    const rows = await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .select({
          sealed: tenantCertificates.sealed,
          fingerprint: tenantCertificates.fingerprint,
          notBefore: tenantCertificates.notBefore,
          notAfter: tenantCertificates.notAfter,
        })
        .from(tenantCertificates)
        .where(
          and(
            eq(tenantCertificates.environment, environment),
            eq(tenantCertificates.status, 'active'),
          ),
        ),
    );
    const row = rows.at(0);
    if (!row) throw new CertificateNotFoundError(environment);
    const now = (this.options.now ?? (() => new Date()))();
    if (now > row.notAfter) throw new CertificateValidityError('expired');
    if (now < row.notBefore) throw new CertificateValidityError('not-yet-valid');
    const plaintext = await this.cipher.open(
      row.sealed as SealedSecret,
      this.context(tenantId, environment, row.fingerprint),
    );
    try {
      const payload = JSON.parse(plaintext.toString('utf8')) as { p12: string; password: string };
      return {
        p12: Buffer.from(payload.p12, 'base64'),
        password: payload.password,
        fingerprint: row.fingerprint,
      };
    } finally {
      plaintext.fill(0);
    }
  }
}
