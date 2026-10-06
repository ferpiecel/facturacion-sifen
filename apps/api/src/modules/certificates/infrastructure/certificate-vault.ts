import { createHash, type X509Certificate } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  tenantCertificates,
  tenantFiscalProfiles,
  tenants,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import type { AuditEntry, RecordAudit } from '../../audit/application/ports/record-audit.port.js';
import { recordAudit as defaultRecordAudit } from '../../audit/infrastructure/record-audit.js';
import type { EnvelopeCipher } from '../../custody/application/envelope-cipher.js';
import type { SealedSecret, SecretContext } from '../../custody/domain/sealed-secret.js';
import { createRuc, formatRuc } from '../../fiscal-config/domain/ruc.js';
import {
  validateTenantCertificate,
  type CertificateRejection,
} from '../domain/tenant-certificate.js';
import { inspectPkcs12 } from './pkcs12-inspector.js';

const CERTIFICATE_VERSION = 1;

type AuditActor = AuditEntry['actor'];

/** The operator CLI is the only writer of certificates today. */
const OPERATOR_ACTOR: AuditActor = { type: 'operator', id: 'ops-cli' };

/** Who decrypts a certificate and why; recorded in `certificate.accessed` (ADR-0009). */
export interface CertificateAccess {
  readonly actor: AuditActor;
  readonly purpose: string;
}

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
  /** Audit actor of the upload; defaults to the operator CLI. */
  readonly actor?: AuditActor;
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
  /** Audit writer, injectable for tests; defaults to `recordAudit` (needs the tenant transaction context). */
  readonly recordAudit?: RecordAudit<TenantTx>;
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
    const {
      tenantId,
      environment,
      p12,
      password,
      replace = false,
      actor = OPERATOR_ACTOR,
    } = params;
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
    const audit = this.options.recordAudit ?? defaultRecordAudit;
    return db.transaction(async (tx) => {
      // The audit rows commit or roll back with the write; recordAudit reads the tenant from here.
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`);
      const active = await tx
        .select({
          id: tenantCertificates.id,
          fingerprint: tenantCertificates.fingerprint,
        })
        .from(tenantCertificates)
        .where(
          and(
            eq(tenantCertificates.tenantId, tenantId),
            eq(tenantCertificates.environment, environment),
            eq(tenantCertificates.status, 'active'),
          ),
        );
      const previous = active.at(0);
      if (previous) {
        if (!replace) throw new ActiveCertificateExistsError(environment);
        await tx
          .update(tenantCertificates)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(eq(tenantCertificates.id, previous.id));
        await audit(tx, {
          actor,
          action: 'certificate.revoked',
          entity: { type: 'certificate', id: previous.id },
          before: { status: 'active' },
          after: { status: 'revoked', environment, fingerprint: previous.fingerprint },
        });
      }
      const [row] = await tx
        .insert(tenantCertificates)
        .values({ tenantId, environment, sealed, ...stored })
        .returning({ id: tenantCertificates.id });
      await audit(tx, {
        actor,
        action: previous ? 'certificate.replaced' : 'certificate.added',
        entity: { type: 'certificate', id: row.id },
        before: previous ? { previousId: previous.id, fingerprint: previous.fingerprint } : null,
        after: {
          environment,
          fingerprint,
          subjectRuc: stored.subjectRuc,
          status: 'active',
        },
      });
      return { id: row.id, ...stored };
    });
  }

  /**
   * The tenant's active certificate fingerprint when it is within its validity window, else null.
   * Reads only the public columns: no decrypt, no audit. The cache re-checks it on every hit, so a
   * revoke or replace made by another process takes effect on the next signing.
   */
  async currentFingerprint(
    db: Database,
    tenantId: string,
    environment: Environment,
  ): Promise<string | null> {
    const now = (this.options.now ?? (() => new Date()))();
    const rows = await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .select({
          fingerprint: tenantCertificates.fingerprint,
          notBefore: tenantCertificates.notBefore,
          notAfter: tenantCertificates.notAfter,
        })
        .from(tenantCertificates)
        .where(
          and(
            eq(tenantCertificates.tenantId, tenantId),
            eq(tenantCertificates.environment, environment),
            eq(tenantCertificates.status, 'active'),
          ),
        ),
    );
    const row = rows.at(0);
    return row && now >= row.notBefore && now <= row.notAfter ? row.fingerprint : null;
  }

  /**
   * Decrypts the tenant's active certificate in memory; the caller owns the returned buffer and
   * should zeroize it. Never logged, never persisted.
   *
   * Every decrypt is audited (`certificate.accessed`, fingerprint and purpose only) in the same tenant
   * transaction that reads the row, and committed BEFORE the key is touched: fail closed, since
   * ADR-0009 requires every key access to be audited, so a failing audit means no decrypt. A
   * cache (S3) must wrap this method so only decrypts, not cache hits, are audited.
   *
   * @throws CertificateNotFoundError when there is no active certificate.
   * @throws CertificateValidityError when it is expired or not yet valid at `now`.
   * @throws SecretDecryptionError when the stored blob does not match its row identity.
   */
  async open(
    db: Database,
    tenantId: string,
    environment: Environment,
    access: CertificateAccess,
  ): Promise<OpenedCertificate> {
    const audit = this.options.recordAudit ?? defaultRecordAudit;
    const now = (this.options.now ?? (() => new Date()))();
    const row = await withTenantTransaction(db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: tenantCertificates.id,
          sealed: tenantCertificates.sealed,
          fingerprint: tenantCertificates.fingerprint,
          notBefore: tenantCertificates.notBefore,
          notAfter: tenantCertificates.notAfter,
        })
        .from(tenantCertificates)
        .where(
          and(
            // RLS already scopes the rows; the explicit filter is defence in depth.
            eq(tenantCertificates.tenantId, tenantId),
            eq(tenantCertificates.environment, environment),
            eq(tenantCertificates.status, 'active'),
          ),
        );
      const found = rows.at(0);
      if (!found) throw new CertificateNotFoundError(environment);
      if (now > found.notAfter) throw new CertificateValidityError('expired');
      if (now < found.notBefore) throw new CertificateValidityError('not-yet-valid');
      await audit(tx, {
        actor: access.actor,
        action: 'certificate.accessed',
        entity: { type: 'certificate', id: found.id },
        before: null,
        after: { environment, fingerprint: found.fingerprint, purpose: access.purpose },
      });
      return found;
    });
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
