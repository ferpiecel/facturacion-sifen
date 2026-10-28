import { and, eq, ne, sql } from 'drizzle-orm';
import {
  issuerEvents,
  tenantFiscalProfiles,
  tenants,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { EventKeyCollisionError } from '../application/ports/cancellation-unit-of-work.port.js';
import {
  ReceiverEventDuplicateError,
  type ReceiverEventData,
  type ReceiverEventUnit,
  type ReceiverEventUnitOfWork,
} from '../application/ports/receiver-event-unit-of-work.port.js';
import type { ReceiverEventKind } from '../domain/receiver-event-rules.js';
import {
  first,
  isKeyCollision,
  isReceiverDuplicate,
  takeEventId,
} from './drizzle-event-support.js';

export function createUnit(tx: TenantTx, tenantId: string): ReceiverEventUnit {
  return {
    async findByIdempotencyKey(key) {
      const row = await tx
        .select({
          id: issuerEvents.id,
          kind: issuerEvents.kind,
          cdc: issuerEvents.targetCdc,
          requestHash: issuerEvents.requestHash,
        })
        .from(issuerEvents)
        .where(and(eq(issuerEvents.tenantId, tenantId), eq(issuerEvents.idempotencyKey, key)))
        .then(first);
      if (!row?.requestHash || !row.cdc) return null;
      return {
        eventId: row.id,
        kind: row.kind as ReceiverEventKind,
        cdc: row.cdc,
        requestHash: row.requestHash,
      };
    },
    async lockCdc(cdc) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${cdc}`}, 0))`,
      );
    },
    async receiverIdentity() {
      const row = await tx
        .select({
          environment: tenants.environment,
          rucBase: tenantFiscalProfiles.rucBase,
          rucDv: tenantFiscalProfiles.rucDv,
          legalName: tenantFiscalProfiles.legalName,
        })
        .from(tenants)
        .leftJoin(tenantFiscalProfiles, eq(tenantFiscalProfiles.tenantId, tenants.id))
        .where(eq(tenants.id, tenantId))
        .then(first);
      if (!row) throw new Error('tenant not found');
      const party =
        row.rucBase !== null && row.rucDv !== null && row.legalName !== null
          ? { ruc: `${row.rucBase}-${String(row.rucDv)}`, name: row.legalName }
          : null;
      return { environment: row.environment, party };
    },
    async listEvents(cdc, environment) {
      const rows = await tx
        .select({
          kind: issuerEvents.kind,
          data: issuerEvents.receiverData,
          createdAt: issuerEvents.createdAt,
        })
        .from(issuerEvents)
        .where(
          and(
            eq(issuerEvents.tenantId, tenantId),
            eq(issuerEvents.environment, environment),
            eq(issuerEvents.targetCdc, cdc),
            ne(issuerEvents.status, 'rejected'),
          ),
        );
      return rows.map((row) => ({
        kind: row.kind as ReceiverEventKind,
        conformityType: (row.data as ReceiverEventData | null)?.conformityType,
        registeredAt: row.createdAt,
      }));
    },
    async insertEvent(event) {
      const eventId = await takeEventId(tx, tenantId, event.environment);
      try {
        const [row] = await tx
          .insert(issuerEvents)
          .values({
            tenantId,
            environment: event.environment,
            kind: event.kind,
            eventId,
            targetCdc: event.cdc,
            receiverData: event.data,
            reason: event.reason,
            idempotencyKey: event.idempotencyKey,
            requestHash: event.requestHash,
            correctsEventId: event.correction?.originalEventId ?? null,
            correctionReason: event.correction?.reason ?? null,
          })
          .returning({ id: issuerEvents.id });
        return { id: row.id };
      } catch (error) {
        if (isKeyCollision(error)) throw new EventKeyCollisionError();
        if (isReceiverDuplicate(error)) throw new ReceiverEventDuplicateError();
        throw error;
      }
    },
    recordAudit: (entry) => recordAudit(tx, entry),
  };
}

/** Runs the registration inside `withTenantTransaction`, so RLS scopes every query to the tenant. */
export function createDrizzleReceiverEventUnitOfWork(db: Database): ReceiverEventUnitOfWork {
  return {
    run: (tenantId, work) =>
      withTenantTransaction(db, tenantId, (tx) => work(createUnit(tx, tenantId))),
  };
}
