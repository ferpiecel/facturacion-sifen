import { and, desc, eq, sql } from 'drizzle-orm';
import { tenantDocumentSequences, tenantEnvironment } from './schema.js';
import { DocumentNumberExhaustedError, nextSeries } from './series.js';
import type { TenantTx } from './tenant-transaction.js';

/** `documentType` is not an `iTiDE` code (1..8). */
export class InvalidDocumentTypeError extends Error {
  constructor(documentType: number) {
    super(`invalid iTiDE document type: ${String(documentType)} (expected an integer 1..8)`);
    this.name = 'InvalidDocumentTypeError';
  }
}

export { DocumentNumberExhaustedError };

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

/** One issued `dSerieNum` + `dNumDoc` pair. `series` is null until the first 9999999 is used up. */
export interface DocumentNumber {
  series: string | null;
  number: number;
}

/**
 * Atomically assigns the next `dNumDoc` (1..9999999) and its `dSerieNum` for
 * `key`. Numbering starts without a series; once 9999999 is issued, the next
 * call opens series AA at number 1 (then AB..ZZ), recording its start date
 * (HU-E4-02, rule 1110).
 *
 * Must run inside the caller's tenant transaction (`withTenantTransaction`):
 * the current series row is locked until that transaction ends, so concurrent
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
 * @throws SeriesExhaustedError when series ZZ already issued 9999999.
 */
export async function nextDocumentNumber(
  tx: TenantTx,
  key: DocumentSequenceKey,
): Promise<DocumentNumber> {
  if (!Number.isInteger(key.documentType) || key.documentType < 1 || key.documentType > 8) {
    throw new InvalidDocumentTypeError(key.documentType);
  }
  const t = tenantDocumentSequences;
  const [current]: ({ series: string; lastNumber: number } | undefined)[] = await tx
    .select({ series: t.series, lastNumber: t.lastNumber })
    .from(t)
    .where(
      and(
        eq(t.tenantId, key.tenantId),
        eq(t.environment, key.environment),
        eq(t.timbradoId, key.timbradoId),
        eq(t.establishmentId, key.establishmentId),
        eq(t.expeditionPointId, key.expeditionPointId),
        eq(t.documentType, key.documentType),
      ),
    )
    // '' (no series) sorts before 'AA'..'ZZ', so the newest series comes first.
    .orderBy(desc(t.series))
    .limit(1)
    .for('update');

  const exhausted = current?.lastNumber === MAX_DOCUMENT_NUMBER;
  // Callers queued behind a rollover land here with the same exhausted row:
  // the upsert then joins the series the first caller just opened.
  const series = exhausted
    ? nextSeries(current.series === '' ? null : current.series)
    : (current?.series ?? '');

  const rows = await tx
    .insert(t)
    .values({ ...key, series, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [
        t.tenantId,
        t.environment,
        t.timbradoId,
        t.establishmentId,
        t.expeditionPointId,
        t.documentType,
        t.series,
      ],
      set: { lastNumber: sql`${t.lastNumber} + 1` },
      setWhere: sql`${t.lastNumber} < ${MAX_DOCUMENT_NUMBER}`,
    })
    .returning({ series: t.series, lastNumber: t.lastNumber });

  if (rows.length === 0) {
    throw new DocumentNumberExhaustedError();
  }
  return { series: rows[0].series === '' ? null : rows[0].series, number: rows[0].lastNumber };
}
