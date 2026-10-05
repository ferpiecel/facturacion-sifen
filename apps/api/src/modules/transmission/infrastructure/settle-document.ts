import { and, eq } from 'drizzle-orm';
import { documents, loteDocuments, withTenantTransaction } from '@sifen/db';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import type { DocumentResolution } from '../application/poll-lote-result.js';

export type Tx = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

/** `submitted -> outcome`; a document already settled the same way is left alone, anything else aborts the transaction. */
export async function settleDocument(
  tx: Tx,
  tenantId: string,
  loteId: string,
  { cdc, status, messages }: DocumentResolution,
  at: Date,
): Promise<void> {
  const doc = (
    await tx
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .innerJoin(
        loteDocuments,
        and(
          eq(loteDocuments.tenantId, documents.tenantId),
          eq(loteDocuments.documentId, documents.id),
        ),
      )
      .where(and(eq(loteDocuments.loteId, loteId), eq(documents.cdc, cdc)))
  ).at(0);
  if (!doc) throw new Error(`Document ${cdc} is not part of lote ${loteId}`);
  if (doc.status === status) return;
  if (doc.status !== 'submitted') {
    throw new Error(`Document ${cdc} is ${doc.status}, expected submitted`);
  }
  const updated = await tx
    .update(documents)
    .set({ status, sifenMessages: messages, updatedAt: at })
    .where(and(eq(documents.id, doc.id), eq(documents.status, 'submitted')))
    .returning({ id: documents.id });
  if (updated.length !== 1)
    throw new Error(`Document ${cdc} changed while settling lote ${loteId}`);
  // Transactional outbox: the document.approved / rejected delivery commits with the settlement.
  await enqueueDocumentEvents(tx, { tenantId, documentIds: [doc.id], at });
}
