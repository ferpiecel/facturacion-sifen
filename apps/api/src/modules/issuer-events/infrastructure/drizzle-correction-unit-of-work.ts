import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import { issuerEvents, withTenantTransaction, type Database, type TenantTx } from '@sifen/db';
import type {
  CorrectionUnit,
  CorrectionUnitOfWork,
} from '../application/ports/receiver-event-unit-of-work.port.js';
import type { ConformityType, ReceiverEventKind } from '../domain/receiver-event-rules.js';
import { createUnit } from './drizzle-receiver-event-unit-of-work.js';
import { first } from './drizzle-event-support.js';

const CONCLUSIVE: readonly ReceiverEventKind[] = ['conformity', 'disconformity', 'unawareness'];

function createCorrectionUnit(tx: TenantTx, tenantId: string): CorrectionUnit {
  const ofTenant = (eventId: string) =>
    and(eq(issuerEvents.tenantId, tenantId), eq(issuerEvents.id, eventId));
  return {
    ...createUnit(tx, tenantId),
    async cdcOfEvent(eventId) {
      const row = await tx
        .select({ cdc: issuerEvents.targetCdc })
        .from(issuerEvents)
        .where(ofTenant(eventId))
        .then(first);
      return row?.cdc ?? null;
    },
    async findCorrectable(eventId) {
      const row = await tx.select().from(issuerEvents).where(ofTenant(eventId)).then(first);
      if (!row?.targetCdc) return null;
      const cdc = row.targetCdc;
      const corrected = await tx
        .select({ id: issuerEvents.id })
        .from(issuerEvents)
        .where(and(eq(issuerEvents.correctsEventId, row.id), ne(issuerEvents.status, 'rejected')))
        .then(first);
      const later = await tx
        .select({ id: issuerEvents.id })
        .from(issuerEvents)
        .where(
          and(
            eq(issuerEvents.tenantId, tenantId),
            eq(issuerEvents.environment, row.environment),
            eq(issuerEvents.targetCdc, cdc),
            inArray(issuerEvents.kind, [...CONCLUSIVE]),
            ne(issuerEvents.status, 'rejected'),
            gt(issuerEvents.createdAt, row.createdAt),
          ),
        )
        .then(first);
      const data = row.receiverData as { conformityType?: ConformityType } | null;
      return {
        cdc,
        kind: row.kind as ReceiverEventKind,
        conformityType: data?.conformityType,
        status: row.status,
        respondedAt: row.respondedAt,
        isCorrection: row.correctsEventId !== null,
        alreadyCorrected: corrected !== undefined,
        isLatestConclusive: later === undefined,
      };
    },
  };
}

/** Runs the correction inside `withTenantTransaction`, so RLS scopes every query to the tenant. */
export function createDrizzleCorrectionUnitOfWork(db: Database): CorrectionUnitOfWork {
  return {
    run: (tenantId, work) =>
      withTenantTransaction(db, tenantId, (tx) => work(createCorrectionUnit(tx, tenantId))),
  };
}
