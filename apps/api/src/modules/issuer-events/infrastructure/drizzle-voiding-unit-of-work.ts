import { and, asc, between, eq, ne, notInArray, sql } from 'drizzle-orm';
import {
  documents,
  issuerEvents,
  tenantDocumentSequences,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { EventKeyCollisionError } from '../application/ports/cancellation-unit-of-work.port.js';
import type {
  VoidingUnit,
  VoidingUnitOfWork,
} from '../application/ports/voiding-unit-of-work.port.js';
import type { VoidRange } from '../domain/void-rules.js';
import { first, isKeyCollision, takeEventId } from './drizzle-event-support.js';

function createUnit(tx: TenantTx, tenantId: string): VoidingUnit {
  const sequenceKey = (
    scope: {
      environment: 'test' | 'production';
      timbradoId: string;
      establishmentId: string;
      expeditionPointId: string;
    },
    range: VoidRange,
  ) =>
    and(
      eq(tenantDocumentSequences.tenantId, tenantId),
      eq(tenantDocumentSequences.environment, scope.environment),
      eq(tenantDocumentSequences.timbradoId, scope.timbradoId),
      eq(tenantDocumentSequences.establishmentId, scope.establishmentId),
      eq(tenantDocumentSequences.expeditionPointId, scope.expeditionPointId),
      eq(tenantDocumentSequences.documentType, range.type),
      eq(tenantDocumentSequences.series, range.series ?? ''),
    );

  return {
    async findByIdempotencyKey(key) {
      const row = await tx
        .select({
          id: issuerEvents.id,
          documentId: issuerEvents.documentId,
          requestHash: issuerEvents.requestHash,
        })
        .from(issuerEvents)
        .where(and(eq(issuerEvents.tenantId, tenantId), eq(issuerEvents.idempotencyKey, key)))
        .then(first);
      if (!row?.requestHash) return null;
      return { eventId: row.id, documentId: row.documentId, requestHash: row.requestHash };
    },
    async resolveScope(range) {
      const timbrado = await tx
        .select({ id: tenantTimbrados.id })
        .from(tenantTimbrados)
        .where(
          and(eq(tenantTimbrados.tenantId, tenantId), eq(tenantTimbrados.number, range.timbrado)),
        )
        .then(first);
      if (!timbrado) return { found: false, unknown: 'timbrado' };
      const establishment = await tx
        .select({ id: tenantEstablishments.id })
        .from(tenantEstablishments)
        .where(
          and(
            eq(tenantEstablishments.tenantId, tenantId),
            eq(tenantEstablishments.code, range.establishment),
          ),
        )
        .then(first);
      if (!establishment) return { found: false, unknown: 'establishment' };
      const point = await tx
        .select({ id: tenantExpeditionPoints.id })
        .from(tenantExpeditionPoints)
        .where(
          and(
            eq(tenantExpeditionPoints.tenantId, tenantId),
            eq(tenantExpeditionPoints.establishmentId, establishment.id),
            eq(tenantExpeditionPoints.code, range.point),
          ),
        )
        .then(first);
      if (!point) return { found: false, unknown: 'expedition-point' };
      const tenant = await tx
        .select({ environment: tenants.environment })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .then(first);
      return {
        found: true,
        environment: tenant?.environment ?? 'test',
        timbradoId: timbrado.id,
        establishmentId: establishment.id,
        expeditionPointId: point.id,
      };
    },
    async lockLastNumber(scope, range) {
      const row = await tx
        .select({ lastNumber: tenantDocumentSequences.lastNumber })
        .from(tenantDocumentSequences)
        .where(sequenceKey(scope, range))
        .for('update')
        .then(first);
      return row?.lastNumber ?? null;
    },
    async listDocumentNumbersInRange(scope, range, limit) {
      const rows = await tx
        .select({ number: documents.number })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.environment, scope.environment),
            eq(documents.timbradoId, scope.timbradoId),
            eq(documents.establishmentId, scope.establishmentId),
            eq(documents.expeditionPointId, scope.expeditionPointId),
            eq(documents.documentType, range.type),
            eq(documents.series, range.series ?? ''),
            between(documents.number, range.from, range.to),
            notInArray(documents.status, ['rejected', 'number_voided']),
          ),
        )
        .orderBy(asc(documents.number))
        .limit(limit);
      return rows.map((r) => r.number);
    },
    async listOpenVoidRanges(range) {
      const rows = await tx
        .select({ range: issuerEvents.voidRange })
        .from(issuerEvents)
        .where(
          and(
            eq(issuerEvents.tenantId, tenantId),
            eq(issuerEvents.kind, 'voiding'),
            ne(issuerEvents.status, 'rejected'),
            sql`${issuerEvents.voidRange}->>'timbrado' = ${range.timbrado}`,
            sql`${issuerEvents.voidRange}->>'establishment' = ${range.establishment}`,
            sql`${issuerEvents.voidRange}->>'point' = ${range.point}`,
            sql`(${issuerEvents.voidRange}->>'type')::int = ${range.type}`,
            sql`coalesce(${issuerEvents.voidRange}->>'series', '') = ${range.series ?? ''}`,
          ),
        );
      return rows.map((r) => r.range as VoidRange);
    },
    async insertVoiding(event) {
      const eventId = await takeEventId(tx, tenantId, event.environment);
      try {
        const [row] = await tx
          .insert(issuerEvents)
          .values({
            tenantId,
            environment: event.environment,
            kind: 'voiding',
            eventId,
            voidRange: event.range,
            reason: event.reason,
            idempotencyKey: event.idempotencyKey,
            requestHash: event.requestHash,
          })
          .returning({ id: issuerEvents.id });
        return { id: row.id };
      } catch (error) {
        if (isKeyCollision(error)) throw new EventKeyCollisionError();
        throw error;
      }
    },
    recordAudit: (entry) => recordAudit(tx, entry),
  };
}

/** Runs the voiding inside `withTenantTransaction`, so RLS scopes every query to the tenant. */
export function createDrizzleVoidingUnitOfWork(db: Database): VoidingUnitOfWork {
  return {
    run: (tenantId, work) =>
      withTenantTransaction(db, tenantId, (tx) => work(createUnit(tx, tenantId))),
  };
}
