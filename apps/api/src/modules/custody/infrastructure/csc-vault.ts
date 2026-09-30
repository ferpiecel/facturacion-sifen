import { and, eq, sql } from 'drizzle-orm';
import { tenantCscs, tenants, withTenantTransaction, type Database } from '@sifen/db';
import type { SealedSecret, SecretContext } from '../domain/sealed-secret.js';
import type { EnvelopeCipher } from '../application/envelope-cipher.js';

/** Maximum CSCs per tenant and environment (HU-E2-03). */
export const MAX_CSC_PER_ENVIRONMENT = 2;
const CSC_VERSION = 1;

export class CscLimitError extends Error {
  constructor(environment: string) {
    super(`tenant already has ${String(MAX_CSC_PER_ENVIRONMENT)} CSC for ${environment}`);
    this.name = 'CscLimitError';
  }
}

export interface AddCscParams {
  tenantId: string;
  environment: 'test' | 'production';
  idCsc: string;
  /** Already validated with `parseCsc`. */
  value: string;
}

/**
 * Custody of tenant CSCs (ADR-0009): sealed with {@link EnvelopeCipher} before
 * storage, opened only in memory, never returned in clear by any listing.
 */
export class CscVault {
  constructor(private readonly cipher: EnvelopeCipher) {}

  private context(tenantId: string, environment: 'test' | 'production'): SecretContext {
    return { tenantId, kind: 'csc', environment, version: CSC_VERSION };
  }

  /** Operator path (owner connection): seals and inserts in one transaction. */
  async add(db: Database, params: AddCscParams): Promise<void> {
    const { tenantId, environment, idCsc, value } = params;
    const sealed = await this.cipher.seal(
      Buffer.from(value, 'utf8'),
      this.context(tenantId, environment),
    );
    await db.transaction(async (tx) => {
      const found = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (found.length === 0) {
        throw new Error(`tenant not found: ${tenantId}`);
      }
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(tenantCscs)
        .where(and(eq(tenantCscs.tenantId, tenantId), eq(tenantCscs.environment, environment)));
      if (count.n >= MAX_CSC_PER_ENVIRONMENT) {
        throw new CscLimitError(environment);
      }
      await tx.insert(tenantCscs).values({ tenantId, environment, idCsc, sealed });
    });
  }

  /**
   * Decrypts in memory inside the tenant's RLS scope; the caller owns and
   * should zeroize the returned buffer.
   *
   * @throws SecretDecryptionError when the stored blob does not match its identity.
   */
  async getPlaintext(
    db: Database,
    tenantId: string,
    environment: 'test' | 'production',
    idCsc: string,
  ): Promise<Buffer> {
    const rows = await withTenantTransaction(db, tenantId, (tx) =>
      tx
        .select({ sealed: tenantCscs.sealed })
        .from(tenantCscs)
        .where(and(eq(tenantCscs.environment, environment), eq(tenantCscs.idCsc, idCsc))),
    );
    const row = rows.at(0);
    if (!row) {
      throw new Error(`CSC not found: ${idCsc} (${environment})`);
    }
    return this.cipher.open(row.sealed as SealedSecret, this.context(tenantId, environment));
  }
}
