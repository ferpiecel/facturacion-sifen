import { and, eq, inArray } from 'drizzle-orm';
import { documentEmails, documents, type TenantTx } from '@sifen/db';
import { readReceiverEmail } from '../domain/receiver-email.js';

const APPROVED = ['approved', 'approved_with_observations'];

export interface EnqueueDocumentEmailsInput {
  readonly tenantId: string;
  /** Documents whose status was JUST changed by the caller, inside this same transaction. */
  readonly documentIds: readonly string[];
  /** The transition time; also when the email becomes due. */
  readonly at: Date;
}

/**
 * Transactional outbox (HU-E11-02): called with the transaction that approved the documents, so the
 * approval and its email commit or roll back together. Approved documents get one row, `pending` and
 * due at `at`, addressed to the receiver in the signed XML; a receiver without a usable address
 * (innominado) is recorded `skipped` so the absence is visible. Idempotent through UNIQUE(tenant, document).
 */
export async function enqueueDocumentEmails(
  tx: TenantTx,
  { tenantId, documentIds, at }: EnqueueDocumentEmailsInput,
): Promise<void> {
  if (documentIds.length === 0) return;
  const docs = await tx
    .select({ id: documents.id, signedXml: documents.signedXml })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        inArray(documents.id, [...documentIds]),
        inArray(documents.status, APPROVED),
      ),
    );
  const rows: (typeof documentEmails.$inferInsert)[] = [];
  for (const { id, signedXml } of docs) {
    if (signedXml === null) continue;
    const receiver = readReceiverEmail(signedXml);
    rows.push(
      receiver.kind === 'address'
        ? { tenantId, documentId: id, recipient: receiver.address, nextAttemptAt: at }
        : {
            tenantId,
            documentId: id,
            status: 'skipped',
            lastError: receiver.kind === 'none' ? 'no_receiver_email' : 'invalid_receiver_email',
          },
    );
  }
  if (rows.length === 0) return;
  await tx
    .insert(documentEmails)
    .values(rows)
    .onConflictDoNothing({ target: [documentEmails.tenantId, documentEmails.documentId] });
}
