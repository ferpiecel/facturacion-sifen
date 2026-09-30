import { and, eq } from 'drizzle-orm';
import { tenantCscs, tenants, withTenantTransaction, type Database } from '@sifen/db';
import type { SealedSecret, SecretContext } from '../domain/sealed-secret.js';
import type { EnvelopeCipher } from '../application/envelope-cipher.js';

export const MAX_CSC_PER_ENVIRONMENT = 2;
const CSC_VERSION = 1;
const SLOTS = [1, 2] as const;

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
  /**
   * Already validated with `parseCsc`. A string cannot be zeroized; pass a
   * Buffer to have it wiped after sealing.
   */
  value: string | Buffer;
}

/**
 * Custody of tenant CSCs (ADR-0009): sealed with {@link EnvelopeCipher} before
 * storage, opened only in memory, never returned in clear by any listing.
 */
export class CscVault {
  constructor(private readonly cipher: EnvelopeCipher) {}

  private context(
    tenantId: string,
    environment: 'test' | 'production',
    idCsc: string,
  ): SecretContext {
    return { tenantId, kind: 'csc', environment, version: CSC_VERSION, label: idCsc };
  }

  /** Operator path (owner connection): seals and inserts in one transaction. */
  async add(db: Database, params: AddCscParams): Promise<void> {
    const { tenantId, environment, idCsc, value } = params;
    const plaintext = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    let sealed: SealedSecret;
    try {
      sealed = await this.cipher.seal(plaintext, this.context(tenantId, environment, idCsc));
    } finally {
      plaintext.fill(0);
    }
    await db.transaction(async (tx) => {
      const found = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (found.length === 0) {
        throw new Error(`tenant not found: ${tenantId}`);
      }
      const used = await tx
        .select({ slot: tenantCscs.slot })
        .from(tenantCscs)
        .where(and(eq(tenantCscs.tenantId, tenantId), eq(tenantCscs.environment, environment)));
      // A concurrent add picking the same slot hits the unique constraint instead of overflowing.
      const slot = SLOTS.find((candidate) => !used.some((row) => row.slot === candidate));
      if (slot === undefined) {
        throw new CscLimitError(environment);
      }
      await tx.insert(tenantCscs).values({ tenantId, environment, idCsc, slot, sealed });
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
    return this.cipher.open(row.sealed as SealedSecret, this.context(tenantId, environment, idCsc));
  }
}
