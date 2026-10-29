import { and, eq } from 'drizzle-orm';
import {
  documentCorrectionClaims,
  documents,
  withTenantTransaction,
  type Database,
} from '@sifen/db';
import { recordAudit } from '../modules/audit/infrastructure/record-audit.js';
import { requestHash } from '../modules/emission/domain/request-hash.js';

export interface ReleaseCorrectionClaimParams {
  tenantId: string;
  documentId: string;
  /** Names the operator in the audit entry. */
  actor: string;
}

/**
 * Operator CLI (HU-E8-01, ADR-0021): releases the claim a reissue holds on a rejected document when it
 * went stale (the replacement was never issued and the caller will not retry). Refuses when the
 * replacement already exists: it must be linked by retrying the correction, otherwise a later rewrite would
 * leave two live documents. Audits the release; a document of another tenant is reported as not found.
 */
export async function releaseCorrectionClaim(
  db: Database,
  { tenantId, documentId, actor }: ReleaseCorrectionClaimParams,
): Promise<{ documentId: string; idempotencyKey: string }> {
  return withTenantTransaction(db, tenantId, async (tx) => {
    // The document lock serializes with a correction in flight, which takes the same lock.
    const found = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
      .for('update');
    if (found.length === 0) throw new Error(`document not found: ${documentId}`);
    const claim = await tx
      .select({ idempotencyKey: documentCorrectionClaims.idempotencyKey })
      .from(documentCorrectionClaims)
      .where(
        and(
          eq(documentCorrectionClaims.tenantId, tenantId),
          eq(documentCorrectionClaims.documentId, documentId),
        ),
      )
      .then((rows) => rows.at(0));
    if (!claim) throw new Error(`document has no correction claim: ${documentId}`);
    // The key the reissue derives its replacement's acceptance from (correct-document.ts).
    const replacementKey = `${requestHash({ reissueOf: documentId })}:reissue`;
    const replacement = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.idempotencyKey, replacementKey)))
      .then((rows) => rows.at(0));
    if (replacement) {
      throw new Error(`a replacement already exists for document ${documentId}`);
    }
    await tx
      .delete(documentCorrectionClaims)
      .where(
        and(
          eq(documentCorrectionClaims.tenantId, tenantId),
          eq(documentCorrectionClaims.documentId, documentId),
        ),
      );
    await recordAudit(tx, {
      actor: { type: 'operator', id: actor },
      action: 'correction.claim_released',
      entity: { type: 'document', id: documentId },
      before: { idempotencyKey: claim.idempotencyKey },
      after: { claim: null },
    });
    return { documentId, idempotencyKey: claim.idempotencyKey };
  });
}
