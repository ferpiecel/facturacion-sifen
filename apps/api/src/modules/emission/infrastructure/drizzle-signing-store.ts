import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type Database,
  type TenantTx,
} from '@sifen/db';
import { createEstablishment } from '../../fiscal-config/domain/establishment.js';
import { createExpeditionPoint } from '../../fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../../fiscal-config/domain/fiscal-profile.js';
import { createRuc, formatRuc } from '../../fiscal-config/domain/ruc.js';
import { createTimbrado } from '../../fiscal-config/domain/timbrado.js';
import {
  EstablishmentContactMissingError,
  DocumentTypeNotSignableError,
  SigningDataIncompleteError,
  type NotAcceptedDocument,
  type SignableDocument,
  type SigningStore,
} from '../application/ports/signing.port.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import { parseCreateDocument, toInvoiceDraft } from './http/create-document.request.js';
import {
  parseCreateCreditNote,
  parseCreateDebitNote,
  toCreditNoteDraft,
} from './http/credit-note.request.js';
import { parseCreateSelfInvoice, toSelfInvoiceDraft } from './http/self-invoice.request.js';
import type { InvoiceXmlContext, XmlReceiver } from '../application/invoice-xml.js';
import type { FiscalProfile } from '../../fiscal-config/domain/fiscal-profile.js';

export interface DrizzleSigningStoreOptions {
  readonly db: Database;
  readonly now?: () => Date;
}

/**
 * What the XML needs beyond the accepted request: item descriptions (E7); the named receiver data
 * (D2, address block optional) is already validated by `parseCreateDocument`. They are read from the stored payload; a document accepted without them cannot be signed
 * and the store says exactly which fields are missing instead of inventing values.
 */
const xmlDetailSchema = z.object({
  items: z.array(
    z.object({ code: z.string().min(1), description: z.string().min(1), unitCode: z.number() }),
  ),
});

const keyName = (key: string | number | symbol): string =>
  typeof key === 'symbol' ? key.toString() : String(key);

const pathOf = (path: readonly PropertyKey[]): string =>
  path.reduce<string>(
    (text, key) =>
      typeof key === 'number'
        ? `${text}[${String(key)}]`
        : text
          ? `${text}.${keyName(key)}`
          : keyName(key),
    '',
  );

function readPayload(payload: unknown): {
  draft: ReturnType<typeof toInvoiceDraft>;
  receiver: XmlReceiver | undefined;
  items: { code: string; description: string; unitCode: number }[];
} {
  const base = parseCreateDocument(payload);
  if (!base.ok) throw new SigningDataIncompleteError(base.errors.map((e) => e.field));
  const detail = xmlDetailSchema.safeParse(payload);
  if (!detail.success) {
    throw new SigningDataIncompleteError(detail.error.issues.map((i) => pathOf(i.path)));
  }
  const body = base.value;
  // An innominado receiver has no D2 data: the mapper writes the fixed fields (MT v150 D208-D211).
  if (body.receiver.kind !== 'named') {
    return { draft: toInvoiceDraft(body), receiver: undefined, ...detail.data };
  }
  const { ruc, name, address, houseNumber, districtCode, districtDescription } = body.receiver;
  const { cityCode, cityDescription, email } = body.receiver;
  const receiver: XmlReceiver = {
    ruc,
    name,
    ...(address === undefined ? {} : { address }),
    ...(houseNumber === undefined ? {} : { houseNumber }),
    ...(districtCode === undefined ? {} : { districtCode, districtDescription }),
    ...(cityCode === undefined ? {} : { cityCode, cityDescription }),
    ...(email === undefined ? {} : { email }),
  };
  return { draft: toInvoiceDraft(body), receiver, ...detail.data };
}

type NoteData = { associatedCdc: string; reasonCode: number };

/**
 * An NCE (HU-E7-01) or NDE (HU-E7-02): its own items, rounding and reason come from its payload;
 * the receiver, operation and location are the FE's (ADR-0019 D3), read from the FE's stored payload.
 */
function readNotePayload(
  payload: unknown,
  invoicePayload: unknown,
  associatedCdc: string,
  kind: 'credit' | 'debit',
): ReturnType<typeof readPayload> & { note: NoteData } {
  const base = kind === 'credit' ? parseCreateCreditNote(payload) : parseCreateDebitNote(payload);
  if (!base.ok) throw new SigningDataIncompleteError(base.errors.map((e) => e.field));
  const detail = xmlDetailSchema.safeParse(payload);
  if (!detail.success) {
    throw new SigningDataIncompleteError(detail.error.issues.map((i) => pathOf(i.path)));
  }
  const invoice = readPayload(invoicePayload);
  const credit = toCreditNoteDraft(base.value);
  return {
    draft: {
      receiver: invoice.draft.receiver,
      operationType: invoice.draft.operationType,
      location: invoice.draft.location,
      items: credit.items,
      roundingPyg: credit.roundingPyg,
    },
    receiver: invoice.receiver,
    items: detail.data.items,
    note: { associatedCdc, reasonCode: credit.reasonCode },
  };
}

/**
 * An AFE (HU-E7-03): the receiver is the issuer (D206 = D101, 1317), B2C and without location, so
 * the draft is built here and only the seller, the place and the constancia come from the payload.
 */
function readSelfInvoicePayload(
  payload: unknown,
  issuer: FiscalProfile,
): ReturnType<typeof readPayload> & { selfInvoice: InvoiceXmlContext['selfInvoice'] } {
  const base = parseCreateSelfInvoice(payload);
  if (!base.ok) throw new SigningDataIncompleteError(base.errors.map((e) => e.field));
  const detail = xmlDetailSchema.safeParse(payload);
  if (!detail.success) {
    throw new SigningDataIncompleteError(detail.error.issues.map((i) => pathOf(i.path)));
  }
  const { seller, place, certificate, items, roundingPyg } = toSelfInvoiceDraft(base.value);
  return {
    draft: {
      receiver: { kind: 'named', isPublicEntity: false },
      operationType: 'B2C',
      location: {},
      items,
      roundingPyg,
    },
    receiver: { ruc: formatRuc(issuer.ruc), name: issuer.legalName },
    items: detail.data.items,
    selfInvoice: { seller, place, certificate },
  };
}

const first = <T>(rows: T[]): T | undefined => rows.at(0);

/** The XML data of an FE, or of an NCE or NDE together with the FE row it is associated to. */
async function readDocument(
  tx: TenantTx,
  tenantId: string,
  document: typeof documents.$inferSelect,
  issuer: FiscalProfile,
): Promise<
  ReturnType<typeof readPayload> & {
    note?: NoteData;
    noteKind?: 'credit' | 'debit';
    selfInvoice?: InvoiceXmlContext['selfInvoice'];
  }
> {
  if (document.documentType === 1) return readPayload(document.payload);
  if (document.documentType === 4) return readSelfInvoicePayload(document.payload, issuer);
  // Explicit: a type added later must not fall into the credit note branch.
  if (document.documentType !== 5 && document.documentType !== 6) {
    throw new DocumentTypeNotSignableError(document.documentType);
  }
  const { associatedCdc } = document;
  const invoice =
    associatedCdc === null
      ? undefined
      : first(
          await tx
            .select({ payload: documents.payload })
            .from(documents)
            .where(
              and(
                eq(documents.tenantId, tenantId),
                eq(documents.environment, document.environment),
                eq(documents.cdc, associatedCdc),
                eq(documents.documentType, 1),
              ),
            ),
        );
  if (associatedCdc === null || invoice === undefined) {
    throw new SigningDataIncompleteError(['associatedCdc']);
  }
  const noteKind = document.documentType === 5 ? 'credit' : 'debit';
  return {
    ...readNotePayload(document.payload, invoice.payload, associatedCdc, noteKind),
    noteKind,
  };
}

/** `SigningStore` over `documents` and the tenant's fiscal configuration, as app_user under RLS. */
export function createDrizzleSigningStore({
  db,
  now = () => new Date(),
}: DrizzleSigningStoreOptions): SigningStore {
  return {
    async load(tenantId, documentId) {
      return withTenantTransaction(
        db,
        tenantId,
        async (tx): Promise<SignableDocument | NotAcceptedDocument | null> => {
          // RLS already scopes every query; the explicit tenant predicates are defence in depth.
          const document = first(
            await tx
              .select()
              .from(documents)
              .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId))),
          );
          if (!document) return null;
          // Nothing to sign: do not touch the configuration or parse the payload again.
          if (document.status !== 'accepted') {
            return { documentId: document.id, status: document.status };
          }
          // Only an FE (1), an AFE (4), an NCE (5) and an NDE (6) have an XML builder; any other type is held.
          if (![1, 4, 5, 6].includes(document.documentType)) {
            throw new DocumentTypeNotSignableError(document.documentType);
          }
          const tenant = first(
            await tx
              .select({ environment: tenants.environment })
              .from(tenants)
              .where(eq(tenants.id, tenantId)),
          );
          const profile = first(
            await tx
              .select()
              .from(tenantFiscalProfiles)
              .where(eq(tenantFiscalProfiles.tenantId, tenantId)),
          );
          const activities = await tx
            .select()
            .from(tenantFiscalEconomicActivities)
            .where(eq(tenantFiscalEconomicActivities.tenantId, tenantId))
            .orderBy(asc(tenantFiscalEconomicActivities.createdAt));
          const establishment = first(
            await tx
              .select()
              .from(tenantEstablishments)
              .where(
                and(
                  eq(tenantEstablishments.tenantId, tenantId),
                  eq(tenantEstablishments.id, document.establishmentId),
                ),
              ),
          );
          const point = first(
            await tx
              .select()
              .from(tenantExpeditionPoints)
              .where(
                and(
                  eq(tenantExpeditionPoints.tenantId, tenantId),
                  eq(tenantExpeditionPoints.id, document.expeditionPointId),
                ),
              ),
          );
          const timbrado = first(
            await tx
              .select()
              .from(tenantTimbrados)
              .where(
                and(
                  eq(tenantTimbrados.tenantId, tenantId),
                  eq(tenantTimbrados.id, document.timbradoId),
                ),
              ),
          );
          if (!tenant || !profile || !establishment || !point || !timbrado) {
            throw new SigningDataIncompleteError(['fiscal configuration']);
          }
          if (!establishment.phone || !establishment.email) {
            throw new EstablishmentContactMissingError(establishment.code);
          }

          const issuer = createFiscalProfile({
            ruc: createRuc(profile.rucBase, profile.rucDv),
            legalName: profile.legalName,
            tradeName: profile.tradeName,
            taxpayerType: profile.taxpayerType,
            regimeCode: profile.regimeCode,
            economicActivities: activities.map((a) => ({
              code: a.code,
              description: a.description,
            })),
          });
          const readable = await readDocument(tx, tenantId, document, issuer);
          const { draft, receiver, items } = readable;
          return {
            documentId: document.id,
            cdc: document.cdc,
            status: document.status,
            environment: document.environment,
            tenantEnvironment: tenant.environment,
            draft,
            context: {
              environment: document.environment,
              issuer,
              establishment: createEstablishment({
                code: establishment.code,
                address: establishment.address,
                houseNumber: establishment.houseNumber,
                addressComplement1: establishment.addressComplement1,
                addressComplement2: establishment.addressComplement2,
                departmentCode: Number(establishment.departmentCode),
                districtCode: establishment.districtCode,
                districtDescription: establishment.districtDescription,
                cityCode: establishment.cityCode,
                cityDescription: establishment.cityDescription,
                phone: establishment.phone,
                email: establishment.email,
                commercialName: establishment.commercialName,
              }),
              // dDenSuc is optional in the XSD, but xmlgen takes a value: the branch name, else the issuer's.
              establishmentContact: {
                phone: establishment.phone,
                email: establishment.email,
                name: (
                  establishment.commercialName ??
                  profile.tradeName ??
                  profile.legalName
                ).slice(0, 30),
              },
              point: createExpeditionPoint({ code: point.code }),
              timbrado: createTimbrado({
                number: timbrado.number,
                validityStart: timbrado.validFrom,
                validityEnd: timbrado.validTo,
              }),
              numbering: {
                documentNumber: String(document.number).padStart(7, '0'),
                securityCode: document.securityCode,
              },
              issuedAt: document.issuedAt,
              ...(receiver === undefined ? {} : { receiver }),
              ...(readable.selfInvoice === undefined ? {} : { selfInvoice: readable.selfInvoice }),
              ...(readable.note === undefined
                ? {}
                : readable.noteKind === 'debit'
                  ? { debitNote: readable.note }
                  : { creditNote: readable.note }),
              lines: items.map((i) => ({
                code: i.code,
                description: i.description,
                unitCode: i.unitCode,
              })),
            },
          };
        },
      );
    },

    async markSigned(tenantId, documentId, { signedXml, signedAt }) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const at = now();
        const updated = await tx
          .update(documents)
          .set({ status: 'signed', signedXml, signedAt, updatedAt: at })
          .where(
            and(
              eq(documents.tenantId, tenantId),
              eq(documents.id, documentId),
              eq(documents.status, 'accepted'),
            ),
          )
          .returning({ id: documents.id });
        // Transactional outbox: the document.signed delivery commits with the status change.
        await enqueueDocumentEvents(tx, { tenantId, documentIds: updated.map((r) => r.id), at });
        return updated.length === 1;
      });
    },
  };
}
