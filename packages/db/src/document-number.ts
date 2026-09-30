import { sql } from 'drizzle-orm';
import { DocumentNumberExhaustedError } from './errors.js';
import { tenantDocumentSequences } from './schema.js';
import type { TenantTx } from './tenant-transaction.js';

export { DocumentNumberExhaustedError };

/** Highest `dNumDoc` (MT v150: 7 digits). */
export const MAX_DOCUMENT_NUMBER = 9_999_999;

/** Identifies one numbering sequence (HU-E4-01). */
export interface DocumentSequenceKey {
  tenantId: string;
  environment: 'test' | 'production';
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
 * @throws DocumentNumberExhaustedError when the sequence already issued 9999999.
 */
export async function nextDocumentNumber(tx: TenantTx, key: DocumentSequenceKey): Promise<number> {
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
