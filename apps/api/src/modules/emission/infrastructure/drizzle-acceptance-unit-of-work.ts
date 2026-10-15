import { and, desc, eq, gte, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import {
  documents,
  nextDocumentNumber,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import { InvoiceValidationError } from '../application/accept-invoice.js';
import {
  IdempotencyKeyCollisionError,
  type AcceptanceUnit,
  type AcceptanceUnitOfWork,
} from '../application/ports/acceptance-unit-of-work.port.js';
import { parseCreateDocument, toInvoiceDraft } from './http/create-document.request.js';

const IDEMPOTENCY_CONSTRAINT = 'documents_tenant_idempotency_key_key';

/** Whether `error` (or its cause chain) is the unique violation of the idempotency key. */
function isIdempotencyCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { constraint, cause } = error as { constraint?: unknown; cause?: unknown };
  return constraint === IDEMPOTENCY_CONSTRAINT || isIdempotencyCollision(cause);
}

/** First row of a result, typed as possibly missing. */
function first<T>(rows: T[]): T | undefined {
  return rows.at(0);
}

function createUnit(tx: TenantTx, tenantId: string): AcceptanceUnit {
  return {
    async findByIdempotencyKey(key) {
      const row = await tx
        .select({ id: documents.id, cdc: documents.cdc, requestHash: documents.requestHash })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.idempotencyKey, key)))
        .then(first);
      if (!row?.requestHash) return null;
      return { documentId: row.id, cdc: row.cdc, requestHash: row.requestHash };
    },
    async resolveIssuer(query) {
      const tenant = await tx
        .select({ environment: tenants.environment })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .then(first);
      const profile = await tx
        .select()
        .from(tenantFiscalProfiles)
        .where(eq(tenantFiscalProfiles.tenantId, tenantId))
        .then(first);
      const point = await tx
        .select({ establishmentId: tenantEstablishments.id, pointId: tenantExpeditionPoints.id })
        .from(tenantExpeditionPoints)
        .innerJoin(
          tenantEstablishments,
          and(
            eq(tenantEstablishments.tenantId, tenantExpeditionPoints.tenantId),
            eq(tenantEstablishments.id, tenantExpeditionPoints.establishmentId),
          ),
        )
        .where(
          and(
            eq(tenantExpeditionPoints.tenantId, tenantId),
            eq(tenantEstablishments.code, query.establishmentCode),
            eq(tenantExpeditionPoints.code, query.expeditionPointCode),
          ),
        )
        .then(first);
      // Timbrados are per tenant, not per point: the most recent one valid on the issue date.
      const timbrado = await tx
        .select({ id: tenantTimbrados.id })
        .from(tenantTimbrados)
        .where(
          and(
            eq(tenantTimbrados.tenantId, tenantId),
            lte(tenantTimbrados.validFrom, query.issueDate),
            or(isNull(tenantTimbrados.validTo), gte(tenantTimbrados.validTo, query.issueDate)),
          ),
        )
        .orderBy(desc(tenantTimbrados.validFrom))
        .limit(1)
        .then(first);
      if (!tenant || !profile || !point || !timbrado) return null;
      return {
        environment: tenant.environment,
        rucBase: profile.rucBase,
        rucDv: profile.rucDv,
        taxpayerType: profile.taxpayerType === 'persona_fisica' ? 1 : 2,
        timbradoId: timbrado.id,
        establishmentId: point.establishmentId,
        expeditionPointId: point.pointId,
      };
    },
    async findAssociatedInvoice(cdc, environment) {
      const row = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.environment, environment),
            eq(documents.cdc, cdc),
            eq(documents.documentType, 1),
          ),
        )
        .for('no key update')
        .then(first);
      if (!row) return null;
      const body = parseCreateDocument(row.payload);
      if (!body.ok) {
        // A historical payload that no longer parses must not surface as a 500 (HU-E7-01).
        throw new InvoiceValidationError([
          {
            field: 'associatedCdc',
            rule: 'associated-document-unreadable',
            message: 'The associated invoice data cannot be read to issue a credit note',
          },
        ]);
      }
      const draft = toInvoiceDraft(body.value);
      return {
        receiver: draft.receiver,
        operationType: draft.operationType,
        location: draft.location,
        status: row.status,
        currency: row.currency,
        totalAmount: row.totalAmount,
        receiverRuc: row.receiverRuc,
      };
    },
    async sumCreditNotes(cdc, environment) {
      const row = await tx
        .select({ total: sql<string | null>`sum(${documents.totalAmount})` })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.environment, environment),
            eq(documents.associatedCdc, cdc),
            eq(documents.documentType, 5),
            notInArray(documents.status, ['cancelled', 'number_voided']),
          ),
        )
        .then(first);
      return row?.total ?? '0';
    },
    nextNumber: (issuer, documentType) =>
      nextDocumentNumber(tx, {
        tenantId,
        environment: issuer.environment,
        timbradoId: issuer.timbradoId,
        establishmentId: issuer.establishmentId,
        expeditionPointId: issuer.expeditionPointId,
        documentType,
      }),
    async insertDocument(document) {
      try {
        const [row] = await tx
          .insert(documents)
          .values({ ...document, tenantId })
          .returning({ id: documents.id });
        // Transactional outbox: the document.created delivery commits with the document.
        await enqueueDocumentEvents(tx, { tenantId, documentIds: [row.id], at: new Date() });
        return { id: row.id };
      } catch (error) {
        if (isIdempotencyCollision(error)) throw new IdempotencyKeyCollisionError();
        throw error;
      }
    },
    recordAudit: (entry) => recordAudit(tx, entry),
  };
}

/** Runs acceptance work inside `withTenantTransaction`, so RLS scopes every query to the tenant. */
export function createDrizzleAcceptanceUnitOfWork(db: Database): AcceptanceUnitOfWork {
  return {
    run: (tenantId, work) =>
      withTenantTransaction(db, tenantId, (tx) => work(createUnit(tx, tenantId))),
  };
}
