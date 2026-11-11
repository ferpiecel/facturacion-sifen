import { expect } from 'vitest';
import {
  documents,
  issuerEvents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
} from '../../src/schema.js';
import { createTestDatabase } from './harness.js';

export async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  return expect.unreachable('expected the query to reject');
}

export const CDC = '01800695631001001000000112026010111234567891';
export const SIGNED_XML = '<gGroupGesEve><rGesEve><rEve Id="1"/></rGesEve></gGroupGesEve>';
export const RANGE = {
  timbrado: '12345678',
  establishment: '001',
  point: '001',
  from: 1,
  to: 5,
  type: 1,
};

/** Two tenants, a document each (same CDC) and builders of valid events: the base of the issuer_events specs. */
export async function seedIssuerEvents() {
  const handle = await createTestDatabase();
  const { db } = handle;
  const [a, b] = await db
    .insert(tenants)
    .values([{ name: 'A' }, { name: 'B' }])
    .returning();
  async function document(tenantId: string, cdc: string) {
    const [est] = await db
      .insert(tenantEstablishments)
      .values({
        tenantId,
        code: '001',
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        districtCode: '145',
        districtDescription: 'Asuncion',
        cityCode: '3432',
        cityDescription: 'Asuncion',
      })
      .returning();
    const [point] = await db
      .insert(tenantExpeditionPoints)
      .values({ tenantId, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    const [doc] = await db
      .insert(documents)
      .values({
        tenantId,
        environment: 'test',
        timbradoId: timbrado.id,
        establishmentId: est.id,
        expeditionPointId: point.id,
        documentType: 1,
        number: 1,
        cdc,
        securityCode: '123456789',
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: { items: [] },
      })
      .returning();
    return doc.id;
  }
  const docA = await document(a.id, CDC);
  const docB = await document(b.id, CDC);
  const cancel = (
    overrides: Partial<typeof issuerEvents.$inferInsert> = {},
  ): typeof issuerEvents.$inferInsert => ({
    tenantId: a.id,
    environment: 'test',
    kind: 'cancellation',
    eventId: 1n,
    documentId: docA,
    reason: 'Error en los datos del receptor',
    ...overrides,
  });
  const voiding = (
    overrides: Partial<typeof issuerEvents.$inferInsert> = {},
  ): typeof issuerEvents.$inferInsert => ({
    tenantId: a.id,
    environment: 'test',
    kind: 'voiding',
    eventId: 2n,
    voidRange: RANGE,
    reason: 'Numeros que no se usaron',
    ...overrides,
  });
  return { handle, db, a: a.id, b: b.id, docA, docB, cancel, voiding };
}
