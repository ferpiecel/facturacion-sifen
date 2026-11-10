import { and, asc, eq } from 'drizzle-orm';
import {
  receivedArtifacts,
  receivedDocumentFieldConfidences,
  receivedDocumentItems,
  receivedDocuments,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import type { ReceivedDocumentDetail } from '../../application/ports/received-document-query.port.js';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
  type ArtifactMatch,
  type CreateReceivedDocumentResult,
  type FieldConfidence,
  type NewReceivedArtifact,
  type NewReceivedDocument,
  type ReceivedArtifact,
  type ReceivedDocumentGraph,
  type ReceivedDocumentHeader,
  type ReceivedDocumentHeaderInput,
  type ReceivedDocumentItem,
  type ReceivedDocumentRepository,
} from '../../application/ports/received-document-repository.port.js';
import {
  rehydrateReceivedDocument,
  type ReceivedDocument,
} from '../../domain/received-document.js';
import type { ReceivedDocumentSource } from '../../domain/source.js';
import type { ReceivedDocumentStatus } from '../../domain/received-document-status.js';

type DocumentRow = typeof receivedDocuments.$inferSelect;
type ItemRow = typeof receivedDocumentItems.$inferSelect;
type ConfidenceRow = typeof receivedDocumentFieldConfidences.$inferSelect;
type ArtifactRow = typeof receivedArtifacts.$inferSelect;

/** Header fields share their name with the `received_documents` column property. */
const HEADER_KEYS = [
  'documentType',
  'cdc',
  'timbrado',
  'establishmentCode',
  'expeditionPointCode',
  'documentNumber',
  'series',
  'issuerRucBase',
  'issuerRucDv',
  'issuerLegalName',
  'issuerTradeName',
  'issuerAddress',
  'issuerEconomicActivity',
  'receiverRucBase',
  'receiverRucDv',
  'receiverLegalName',
  'receiverType',
  'issuedAt',
  'dueOn',
  'paidOn',
  'paymentCondition',
  'creditTermDays',
  'paymentMethod',
  'currency',
  'exchangeRate',
  'totalExempt',
  'totalZeroRated',
  'taxable5',
  'taxable10',
  'vat5',
  'vat10',
  'totalVat',
  'totalDiscount',
  'totalAmount',
  'totalPyg',
  'sifenStatus',
  'sifenAuthorizedAt',
  'sifenProtocolNumber',
  'rawData',
  'extractionErrorCode',
  'confirmedBy',
] as const satisfies readonly (keyof ReceivedDocumentHeader & keyof DocumentRow)[];

/** Only the known header columns that were actually supplied; stray properties never reach SQL. */
function pickHeader(input: ReceivedDocumentHeaderInput | undefined): Partial<DocumentRow> {
  const supplied = HEADER_KEYS.filter((key) => input?.[key] !== undefined);
  return Object.fromEntries(supplied.map((key) => [key, input?.[key]]));
}

const toHeader = (row: DocumentRow): ReceivedDocumentHeader =>
  Object.fromEntries(
    HEADER_KEYS.map((key) => [key, row[key]]),
  ) as unknown as ReceivedDocumentHeader;

export const toDocument = (row: Omit<DocumentRow, 'rawData'>): ReceivedDocument =>
  rehydrateReceivedDocument({
    id: row.id,
    tenantId: row.tenantId,
    source: row.source as ReceivedDocumentSource,
    status: row.status as ReceivedDocumentStatus,
    version: row.version,
    needsReview: row.needsReview,
    needsReviewReasons: row.needsReviewReasons,
    isOwnReceiver: row.isOwnReceiver,
    confidenceOverall: row.confidenceOverall,
    extractionAttempts: row.extractionAttempts,
    confirmedAt: row.confirmedAt,
  });

const toItem = (row: ItemRow): ReceivedDocumentItem => ({
  position: row.position,
  description: row.description,
  productCode: row.productCode,
  quantity: row.quantity,
  unitOfMeasure: row.unitOfMeasure,
  unitPrice: row.unitPrice,
  discount: row.discount,
  subtotal: row.subtotal,
  vatRate: row.vatRate as ReceivedDocumentItem['vatRate'],
  taxableBase: row.taxableBase,
  vatAmount: row.vatAmount,
});

const toConfidence = (row: ConfidenceRow): FieldConfidence => ({
  fieldName: row.fieldName,
  confidence: row.confidence,
  extractedValue: row.extractedValue,
  correctedValue: row.correctedValue,
  correctedBy: row.correctedBy,
  correctedAt: row.correctedAt,
});

const toArtifact = (row: ArtifactRow): ReceivedArtifact => ({
  id: row.id,
  storageKey: row.storageKey,
  contentType: row.contentType,
  sha256: row.sha256,
  sizeBytes: row.sizeBytes,
  originalName: row.originalName,
  pageCount: row.pageCount,
});

/** One document with its items, confidences and artifact, read inside the caller's transaction. */
export async function readDocumentDetail(
  tx: TenantTx,
  tenantId: string,
  id: string,
): Promise<ReceivedDocumentDetail | null> {
  const row = (
    await tx
      .select()
      .from(receivedDocuments)
      .where(and(eq(receivedDocuments.tenantId, tenantId), eq(receivedDocuments.id, id)))
  ).at(0);
  if (row === undefined) return null;
  const items = await tx
    .select()
    .from(receivedDocumentItems)
    .where(eq(receivedDocumentItems.receivedDocumentId, id))
    .orderBy(asc(receivedDocumentItems.position));
  const confidences = await tx
    .select()
    .from(receivedDocumentFieldConfidences)
    .where(eq(receivedDocumentFieldConfidences.receivedDocumentId, id))
    .orderBy(asc(receivedDocumentFieldConfidences.fieldName));
  const artifact = row.artifactId
    ? (
        await tx
          .select()
          .from(receivedArtifacts)
          .where(
            and(eq(receivedArtifacts.tenantId, tenantId), eq(receivedArtifacts.id, row.artifactId)),
          )
      ).at(0)
    : undefined;
  return {
    document: toDocument(row),
    header: toHeader(row),
    items: items.map(toItem),
    confidences: confidences.map(toConfidence),
    artifact: artifact ? toArtifact(artifact) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Thrown inside the transaction to roll it back when a concurrent insert won the unique index. */
class LostInsertRace extends Error {}

/**
 * `ReceivedDocumentRepository` over the `received_*` tables. Every method opens its own tenant
 * transaction (app_user under forced RLS); the explicit tenant predicates are defence in depth.
 */
export function createDrizzleReceivedDocumentRepository(db: Database): ReceivedDocumentRepository {
  const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenantTransaction(db, tenantId, fn);

  const documentById = (tenantId: string, id: string) =>
    and(eq(receivedDocuments.tenantId, tenantId), eq(receivedDocuments.id, id));

  async function documentByCdc(tx: TenantTx, tenantId: string, cdc: string) {
    const rows = await tx
      .select()
      .from(receivedDocuments)
      .where(and(eq(receivedDocuments.tenantId, tenantId), eq(receivedDocuments.cdc, cdc)));
    return rows.at(0) ?? null;
  }

  async function artifactBySha(tx: TenantTx, tenantId: string, sha256: string) {
    const rows = await tx
      .select()
      .from(receivedArtifacts)
      .where(and(eq(receivedArtifacts.tenantId, tenantId), eq(receivedArtifacts.sha256, sha256)));
    return rows.at(0) ?? null;
  }

  async function documentByArtifact(tx: TenantTx, tenantId: string, artifactId: string) {
    const rows = await tx
      .select()
      .from(receivedDocuments)
      .where(
        and(eq(receivedDocuments.tenantId, tenantId), eq(receivedDocuments.artifactId, artifactId)),
      );
    return rows.at(0) ?? null;
  }

  /** Same CDC, same issuer/timbrado/number, or same artifact content, in that order. */
  async function findExisting(
    tx: TenantTx,
    tenantId: string,
    header: ReceivedDocumentHeaderInput | undefined,
    artifact: NewReceivedArtifact | undefined,
  ): Promise<DocumentRow | null> {
    if (header?.cdc) {
      const byCdc = await documentByCdc(tx, tenantId, header.cdc);
      if (byCdc) return byCdc;
    }
    if (header?.issuerRucBase && header.timbrado && header.documentNumber) {
      const rows = await tx
        .select()
        .from(receivedDocuments)
        .where(
          and(
            eq(receivedDocuments.tenantId, tenantId),
            eq(receivedDocuments.issuerRucBase, header.issuerRucBase),
            eq(receivedDocuments.timbrado, header.timbrado),
            eq(receivedDocuments.documentNumber, header.documentNumber),
          ),
        );
      if (rows.at(0)) return rows[0];
    }
    if (artifact) {
      const stored = await artifactBySha(tx, tenantId, artifact.sha256);
      if (stored) return documentByArtifact(tx, tenantId, stored.id);
    }
    return null;
  }

  async function insertGraph(
    tx: TenantTx,
    tenantId: string,
    input: NewReceivedDocument,
  ): Promise<CreateReceivedDocumentResult> {
    const { document } = input;
    const existing = await findExisting(tx, tenantId, input.header, input.artifact);
    if (existing) return { created: false, document: toDocument(existing) };

    let artifactId: string | null = null;
    if (input.artifact) {
      // An upload stored earlier whose document never got created is attached, not duplicated.
      const stored = await artifactBySha(tx, tenantId, input.artifact.sha256);
      if (stored) {
        artifactId = stored.id;
      } else {
        const rows = await tx
          .insert(receivedArtifacts)
          .values({ ...input.artifact, tenantId })
          .onConflictDoNothing()
          .returning({ id: receivedArtifacts.id });
        if (rows.length === 0) throw new LostInsertRace();
        artifactId = rows[0].id;
      }
    }

    const inserted = await tx
      .insert(receivedDocuments)
      .values({
        ...pickHeader(input.header),
        id: document.id,
        tenantId,
        source: document.source,
        status: document.status,
        version: document.version,
        needsReview: document.needsReview,
        needsReviewReasons: [...document.needsReviewReasons],
        isOwnReceiver: document.isOwnReceiver,
        confidenceOverall: document.confidenceOverall,
        extractionAttempts: document.extractionAttempts,
        confirmedAt: document.confirmedAt,
        artifactId,
      })
      .onConflictDoNothing()
      .returning({ id: receivedDocuments.id });
    if (inserted.length === 0) throw new LostInsertRace();

    if (input.items?.length) {
      await tx
        .insert(receivedDocumentItems)
        .values(
          input.items.map((item) => ({ ...item, tenantId, receivedDocumentId: document.id })),
        );
    }
    if (input.confidences?.length) {
      await tx
        .insert(receivedDocumentFieldConfidences)
        .values(
          input.confidences.map((c) => ({ ...c, tenantId, receivedDocumentId: document.id })),
        );
    }
    return { created: true, document };
  }

  return {
    async create(tenantId, input) {
      if (input.document.tenantId !== tenantId) {
        throw new Error('the document belongs to a different tenant than the transaction');
      }
      try {
        return await inTenant(tenantId, (tx) => insertGraph(tx, tenantId, input));
      } catch (error) {
        if (!(error instanceof LostInsertRace)) throw error;
      }
      // A concurrent request committed the same CDC/number/artifact first: hand back its document.
      const winner = await inTenant(tenantId, (tx) =>
        findExisting(tx, tenantId, input.header, input.artifact),
      );
      if (winner === null) throw new Error('duplicate received document vanished after conflict');
      return { created: false, document: toDocument(winner) };
    },

    async load(tenantId, id): Promise<ReceivedDocumentGraph | null> {
      const detail = await inTenant(tenantId, (tx) => readDocumentDetail(tx, tenantId, id));
      return detail
        ? {
            document: detail.document,
            header: detail.header,
            items: detail.items,
            confidences: detail.confidences,
            artifact: detail.artifact,
          }
        : null;
    },

    async findByCdc(tenantId, cdc) {
      const row = await inTenant(tenantId, (tx) => documentByCdc(tx, tenantId, cdc));
      return row ? toDocument(row) : null;
    },

    findArtifactBySha256(tenantId, sha256): Promise<ArtifactMatch | null> {
      return inTenant(tenantId, async (tx) => {
        const artifact = await artifactBySha(tx, tenantId, sha256);
        if (artifact === null) return null;
        const linked = await documentByArtifact(tx, tenantId, artifact.id);
        return { artifact: toArtifact(artifact), document: linked ? toDocument(linked) : null };
      });
    },

    save(tenantId, document, expectedVersion, change) {
      return inTenant(tenantId, async (tx) => {
        const updated = await tx
          .update(receivedDocuments)
          .set({
            ...pickHeader(change?.header),
            status: document.status,
            version: document.version,
            needsReview: document.needsReview,
            needsReviewReasons: [...document.needsReviewReasons],
            confidenceOverall: document.confidenceOverall,
            extractionAttempts: document.extractionAttempts,
            confirmedAt: document.confirmedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              documentById(tenantId, document.id),
              eq(receivedDocuments.version, expectedVersion),
            ),
          )
          .returning({ id: receivedDocuments.id });
        if (updated.length > 0) return;
        // Nothing was written; tell a stale version apart from a document that is not visible.
        const exists = await tx
          .select({ id: receivedDocuments.id })
          .from(receivedDocuments)
          .where(documentById(tenantId, document.id));
        if (exists.length === 0) throw new ReceivedDocumentNotFoundError(document.id);
        throw new VersionConflictError(document.id, expectedVersion);
      });
    },
  };
}
