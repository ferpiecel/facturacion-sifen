import {
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantTimbrados,
  type Database,
} from '@sifen/db';

/** Inserts one document per status for the tenant (with the establishment, point and timbrado they need). */
export async function seedDocuments(
  db: Database,
  tenantId: string,
  statuses: readonly string[],
): Promise<{ id: string; cdc: string; status: string }[]> {
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
  const rows: { id: string; cdc: string; status: string }[] = [];
  for (const [i, status] of statuses.entries()) {
    const cdc = `0180069563100100100000${String(i + 1).padStart(2, '0')}12026010111234567891`;
    const [row] = await db
      .insert(documents)
      .values({
        tenantId,
        environment: 'test',
        timbradoId: timbrado.id,
        establishmentId: est.id,
        expeditionPointId: point.id,
        documentType: 1,
        number: i + 1,
        cdc,
        securityCode: '123456789',
        status,
        issuedAt: new Date('2026-01-01T12:00:00Z'),
        totalAmount: '110000',
        payload: { receiver: { name: 'Private Person' } },
      })
      .returning();
    rows.push({ id: row.id, cdc, status });
  }
  return rows;
}
