import { eq } from 'drizzle-orm';
import {
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenantTimbrados,
  type Database,
} from '@sifen/db';
import { createAcceptInvoice } from '../../src/modules/emission/application/accept-invoice.js';
import { createDrizzleAcceptanceUnitOfWork } from '../../src/modules/emission/infrastructure/drizzle-acceptance-unit-of-work.js';
import {
  parseCreateDocument,
  toAcceptInvoiceInput,
} from '../../src/modules/emission/infrastructure/http/create-document.request.js';

/** An FE of 1,000,000 PYG to a named receiver: the invoice the credit note tests credit. */
export const FE_BODY = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: { kind: 'named', ruc: '80069563-1', name: 'Cliente SA' },
  items: [
    {
      code: 'A-001',
      description: 'Servicio',
      unitCode: 77,
      quantity: 1,
      unitPrice: 1_000_000,
      vatRate: 10,
    },
  ],
};

/** Fiscal profile, establishment 001, point 002 and a timbrado for the tenant. */
export async function seedIssuer(db: Database, tenantId: string): Promise<void> {
  await db.insert(tenantFiscalProfiles).values({
    tenantId,
    rucBase: '80069563',
    rucDv: 1,
    legalName: 'Empresa SA',
    taxpayerType: 'persona_juridica',
  });
  const [est] = await db
    .insert(tenantEstablishments)
    .values({
      tenantId,
      code: '001',
      address: 'Av. Mariscal Lopez 123',
      houseNumber: '123',
      departmentCode: '11',
      districtCode: '145',
      districtDescription: 'CIUDAD DEL ESTE',
      cityCode: '3432',
      cityDescription: 'PUERTO PTE.STROESSNER (MUNIC)',
      // The signing path needs the establishment contact (dTelEmi, dEmailE).
      phone: '0973-000000',
      email: 'emisor@test.com',
      commercialName: 'Casa Matriz',
    })
    .returning();
  await db
    .insert(tenantExpeditionPoints)
    .values({ tenantId, establishmentId: est.id, code: '002' });
  await db
    .insert(tenantTimbrados)
    .values({ tenantId, number: '22222222', validFrom: '2026-01-01' });
}

/**
 * The FE goes through the real use case, then SIFEN's answer is simulated by moving its status
 * forward to `status`.
 */
export async function acceptInvoiceWithStatus(
  db: Database,
  tenantId: string,
  key: string,
  status = 'approved',
  body: unknown = FE_BODY,
  issuedAt = new Date('2026-03-05T12:00:00Z'),
): Promise<{ documentId: string; cdc: string }> {
  const parsed = parseCreateDocument(body);
  if (!parsed.ok) throw new Error('invalid invoice fixture');
  const accepted = await createAcceptInvoice({
    unitOfWork: createDrizzleAcceptanceUnitOfWork(db),
    now: () => issuedAt,
  })(
    toAcceptInvoiceInput(parsed.value, {
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      payload: parsed.value,
      idempotencyKey: key,
    }),
  );
  const path: Record<string, string[]> = {
    signed: ['signed'],
    cancelled: ['signed', 'submitted', 'approved', 'cancelled'],
  };
  for (const step of path[status] ?? ['signed', 'submitted', status]) {
    await db.update(documents).set({ status: step }).where(eq(documents.id, accepted.documentId));
  }
  return accepted;
}
