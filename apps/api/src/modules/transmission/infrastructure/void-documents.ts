import { and, between, eq, inArray } from 'drizzle-orm';
import {
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantTimbrados,
  type TenantTx,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import { TRANSMISSION_WORKER_ACTOR } from './transmission-audit-actor.js';

/** The range of a voiding as stored in `issuer_events.void_range`. */
export interface VoidedRange {
  readonly timbrado: string;
  readonly establishment: string;
  readonly point: string;
  readonly from: number;
  readonly to: number;
  readonly type: number;
  readonly series?: string;
}

/**
 * SIFEN registered a voiding (HU-E8-03): the rejected documents holding a number of the range become
 * `number_voided`, with their webhook queued in the same transaction. Documents in any other state are left
 * alone: the platform refuses a voiding over them, so one found here is a race, and SIFEN's answer stands.
 * Numbers without a document (gaps) need no row.
 */
export async function voidRejectedDocuments(
  tx: TenantTx,
  tenantId: string,
  environment: 'test' | 'production',
  range: VoidedRange,
  at: Date,
): Promise<void> {
  const timbrados = tx
    .select({ id: tenantTimbrados.id })
    .from(tenantTimbrados)
    .where(and(eq(tenantTimbrados.tenantId, tenantId), eq(tenantTimbrados.number, range.timbrado)));
  const establishments = tx
    .select({ id: tenantEstablishments.id })
    .from(tenantEstablishments)
    .where(
      and(
        eq(tenantEstablishments.tenantId, tenantId),
        eq(tenantEstablishments.code, range.establishment),
      ),
    );
  const points = tx
    .select({ id: tenantExpeditionPoints.id })
    .from(tenantExpeditionPoints)
    .where(
      and(
        eq(tenantExpeditionPoints.tenantId, tenantId),
        eq(tenantExpeditionPoints.code, range.point),
        inArray(tenantExpeditionPoints.establishmentId, establishments),
      ),
    );
  const voided = await tx
    .update(documents)
    .set({ status: 'number_voided', updatedAt: at })
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.environment, environment),
        eq(documents.documentType, range.type),
        eq(documents.series, range.series ?? ''),
        between(documents.number, range.from, range.to),
        eq(documents.status, 'rejected'),
        inArray(documents.timbradoId, timbrados),
        inArray(documents.establishmentId, establishments),
        inArray(documents.expeditionPointId, points),
      ),
    )
    .returning({ id: documents.id });
  for (const { id } of voided) {
    await recordAudit(tx, {
      actor: TRANSMISSION_WORKER_ACTOR,
      action: 'document.number_voided',
      entity: { type: 'document', id },
      before: null,
      after: { status: 'number_voided' },
    });
  }
  if (voided.length > 0) {
    await enqueueDocumentEvents(tx, { tenantId, documentIds: voided.map((d) => d.id), at });
  }
}
