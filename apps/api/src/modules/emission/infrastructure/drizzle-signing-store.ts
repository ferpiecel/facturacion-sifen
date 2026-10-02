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
} from '@sifen/db';
import { createEstablishment } from '../../fiscal-config/domain/establishment.js';
import { createExpeditionPoint } from '../../fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../../fiscal-config/domain/fiscal-profile.js';
import { createRuc } from '../../fiscal-config/domain/ruc.js';
import { createTimbrado } from '../../fiscal-config/domain/timbrado.js';
import {
  EstablishmentContactMissingError,
  SigningDataIncompleteError,
  type NotAcceptedDocument,
  type SignableDocument,
  type SigningStore,
} from '../application/ports/signing.port.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import { parseCreateDocument } from './http/create-document.request.js';

export interface DrizzleSigningStoreOptions {
  readonly db: Database;
  readonly now?: () => Date;
}

/**
 * What the XML needs beyond the accepted request: named-receiver data (D2) and item descriptions
 * (E7). They are read from the stored payload; a document accepted without them cannot be signed
 * and the store says exactly which fields are missing instead of inventing values.
 */
const xmlDetailSchema = z.object({
  receiver: z.object({
    ruc: z.string(),
    name: z.string().min(1),
    address: z.string().min(1),
    houseNumber: z.string().min(1),
    districtCode: z.number(),
    districtDescription: z.string().min(1),
    cityCode: z.number(),
    cityDescription: z.string().min(1),
  }),
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

function readPayload(payload: unknown) {
  const base = parseCreateDocument(payload);
  if (!base.ok) throw new SigningDataIncompleteError(base.errors.map((e) => e.field));
  const detail = xmlDetailSchema.safeParse(payload);
  if (!detail.success) {
    throw new SigningDataIncompleteError(detail.error.issues.map((i) => pathOf(i.path)));
  }
  const body = base.value;
  const draft: InvoiceDraft = {
    receiver:
      body.receiver.kind === 'named'
        ? { kind: 'named', isPublicEntity: body.receiver.isPublicEntity }
        : { kind: 'unnamed' },
    operationType: body.operationType,
    items: body.items as InvoiceDraft['items'],
    roundingPyg: body.roundingPyg,
    location: body.location,
  };
  return { draft, ...detail.data };
}

const first = <T>(rows: T[]): T | undefined => rows.at(0);

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
          const document = first(
            await tx.select().from(documents).where(eq(documents.id, documentId)),
          );
          if (!document) return null;
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
              .where(eq(tenantEstablishments.id, document.establishmentId)),
          );
          const point = first(
            await tx
              .select()
              .from(tenantExpeditionPoints)
              .where(eq(tenantExpeditionPoints.id, document.expeditionPointId)),
          );
          const timbrado = first(
            await tx
              .select()
              .from(tenantTimbrados)
              .where(eq(tenantTimbrados.id, document.timbradoId)),
          );
          if (!tenant || !profile || !establishment || !point || !timbrado) {
            throw new SigningDataIncompleteError(['fiscal configuration']);
          }
          if (!establishment.phone || !establishment.email) {
            throw new EstablishmentContactMissingError(establishment.code);
          }

          const { draft, receiver, items } = readPayload(document.payload);
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
              receiver: {
                ruc: receiver.ruc,
                name: receiver.name,
                address: receiver.address,
                houseNumber: receiver.houseNumber,
                districtCode: receiver.districtCode,
                districtDescription: receiver.districtDescription,
                cityCode: receiver.cityCode,
                cityDescription: receiver.cityDescription,
              },
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
      const updated = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(documents)
          .set({ status: 'signed', signedXml, signedAt, updatedAt: now() })
          .where(and(eq(documents.id, documentId), eq(documents.status, 'accepted')))
          .returning({ id: documents.id }),
      );
      return updated.length === 1;
    },
  };
}
