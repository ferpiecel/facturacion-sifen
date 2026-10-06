import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { documents } from '@sifen/db';

/**
 * SQL condition: the recovery of lote `loteId` still owns the document (`documents` must be in the
 * query). A document the recovery queued again is owned by nobody while it waits for its new lote
 * (`resent_at` after that lote was created) and by the newer lote once it carries it. Without this
 * the old lote would keep asking about, or deciding for, a document that has moved on.
 * Lote creation and `resent_at` both come from the database clock.
 */
export function recoverableInLote(loteId: SQLWrapper | string): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1
      FROM lote_documents ld2
      JOIN lotes l2 ON l2.tenant_id = ld2.tenant_id AND l2.id = ld2.lote_id
      JOIN lotes l1 ON l1.id = ${loteId}
      WHERE ld2.document_id = ${documents.id}
        AND l2.tenant_id = l1.tenant_id
        AND (l2.created_at, l2.id) > (l1.created_at, l1.id)
    )
    AND (
      ${documents.resentAt} IS NULL
      OR ${documents.resentAt} <= (SELECT l3.created_at FROM lotes l3 WHERE l3.id = ${loteId})
    )
  )`;
}
