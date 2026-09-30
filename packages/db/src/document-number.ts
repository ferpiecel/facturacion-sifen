import { sql } from 'drizzle-orm';
import { tenantDocumentSequences, tenantEnvironment } from './schema.js';
import type { TenantTx } from './tenant-transaction.js';

/** Sequence already issued 9999999 (next series is HU-E4-02). */
export class DocumentNumberExhaustedError extends Error {
  constructor() {
    super('dNumDoc exhausted: the sequence already issued 9999999');
    this.name = 'DocumentNumberExhaustedError';
  }
}

/** `documentType` is not an `iTiDE` code (1..8). */
export class InvalidDocumentTypeError extends Error {
  constructor(documentType: number) {
    super(`invalid iTiDE document type: ${String(documentType)} (expected an integer 1..8)`);
    this.name = 'InvalidDocumentTypeError';
  }
}

export const MAX_DOCUMENT_NUMBER = 9_999_999;

/** Identifies one numbering sequence (HU-E4-01). */
export interface DocumentSequenceKey {
  tenantId: string;
  environment: (typeof tenantEnvironment.enumValues)[number];
  timbradoId: string;
  establishmentId: string;
  expeditionPointId: string;
  /** `iTiDE` document type code. */
  documentType: number;
}

/**
 * Atomically assigns the next `dNumDoc` (1..9999999) for `key`.
 *
 * Must run inside the caller's tenant transaction (`withTenantTransaction`):
 * the upsert takes a row lock held until that transaction ends, so concurrent
 * callers on the same key queue up and each gets a distinct consecutive
 * number. The increment commits or rolls back with the caller's transaction,
 * so a rolled-back emission never burns a number (gapless).
 *
 * Lock caveat: the row lock lasts until the caller's transaction ends, so keep
 * the numbering transaction short (no network I/O such as SIFEN calls inside
 * it) and, when locking several sequences, always take them in the same key
 * order to avoid deadlocks.
 *
 * @throws InvalidDocumentTypeError when `documentType` is not an integer 1..8.
 * @throws DocumentNumberExhaustedError when the sequence already issued 9999999.
 */
export async function nextDocumentNumber(tx: TenantTx, key: DocumentSequenceKey): Promise<number> {
  if (!Number.isInteger(key.documentType) || key.documentType < 1 || key.documentType > 8) {
    throw new InvalidDocumentTypeError(key.documentType);
  }
  const rows = await tx
    .insert(tenantDocumentSequences)
    .values({ ...key, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [
        tenantDocumentSequences.tenantId,
        tenantDocumentSequences.environment,
        tenantDocumentSequences.timbradoId,
        tenantDocumentSequences.establishmentId,
        tenantDocumentSequences.expeditionPointId,
        tenantDocumentSequences.documentType,
      ],
      set: { lastNumber: sql`${tenantDocumentSequences.lastNumber} + 1` },
      setWhere: sql`${tenantDocumentSequences.lastNumber} < ${MAX_DOCUMENT_NUMBER}`,
    })
    .returning({ lastNumber: tenantDocumentSequences.lastNumber });

  if (rows.length === 0) {
    throw new DocumentNumberExhaustedError();
  }
  return rows[0].lastNumber;
}
