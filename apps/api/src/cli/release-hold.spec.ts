import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPgliteDatabase,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { parseOpsArgs } from './args.js';
import { releaseDocumentHold } from './commands.js';
import { runOpsCommand } from './ops.js';

/** Spec: HU-E6-02 (S5f follow-up). Operator command that clears a document's transmission hold. */
describe('document:release-hold', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { db } = handle;
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    const [est] = await db
      .insert(tenantEstablishments)
      .values({
        tenantId: a.id,
        code: '001',
        address: 'Calle',
        houseNumber: '1',
        departmentCode: '11',
        cityCode: '3432',
        cityDescription: 'X',
      })
      .returning();
    const [point] = await db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: a.id, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId: a.id, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    const document = async (n: number, hold: string | null) =>
      (
        await db
          .insert(documents)
          .values({
            tenantId: a.id,
            environment: 'test',
            timbradoId: timbrado.id,
            establishmentId: est.id,
            expeditionPointId: point.id,
            documentType: 1,
            number: n,
            cdc: String(n).padStart(44, '0'),
            securityCode: '123456789',
            issuedAt: new Date('2026-01-01T12:00:00Z'),
            totalAmount: '1000',
            payload: {},
            transmissionHold: hold,
            transmissionAttempts: hold ? 5 : 0,
            nextTransmissionAt: hold ? new Date('2026-10-02T12:00:00Z') : null,
          })
          .returning()
      )[0].id;
    return {
      db,
      tenantId: a.id,
      otherTenantId: b.id,
      held: await document(1, 'signing:CscNotConfiguredError'),
      free: await document(2, null),
    };
  }

  const read = (db: DatabaseHandle['db'], id: string) =>
    db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .then((rows) => rows[0]);

  it('clears the hold and resets attempts and backoff, reporting the cleared code', async () => {
    const { db, tenantId, held } = await seed();

    expect(await releaseDocumentHold(db, { tenantId, documentId: held })).toEqual({
      id: held,
      hold: 'signing:CscNotConfiguredError',
    });
    expect(await read(db, held)).toMatchObject({
      transmissionHold: null,
      transmissionAttempts: 0,
      nextTransmissionAt: null,
      status: 'accepted',
    });
  });

  it('refuses a document that is not held, and one of another tenant, leaving rows untouched', async () => {
    const { db, tenantId, otherTenantId, held, free } = await seed();

    await expect(releaseDocumentHold(db, { tenantId, documentId: free })).rejects.toThrow(
      `document is not held: ${free}`,
    );
    await expect(
      releaseDocumentHold(db, { tenantId: otherTenantId, documentId: held }),
    ).rejects.toThrow(`document not found: ${held}`);
    expect((await read(db, held)).transmissionHold).toBe('signing:CscNotConfiguredError');
  });

  it('prints only the ids and the cleared code', async () => {
    const { db, tenantId, held } = await seed();

    const output = await runOpsCommand(db, {
      kind: 'document:release-hold',
      tenantId,
      documentId: held,
    });

    expect(output).toBe(`document hold released: ${held} (was signing:CscNotConfiguredError)`);
  });

  it('parses its arguments strictly', () => {
    expect(parseOpsArgs(['document:release-hold', '--tenant', 't-1', '--document', 'd-1'])).toEqual(
      { kind: 'document:release-hold', tenantId: 't-1', documentId: 'd-1' },
    );
    expect(() => parseOpsArgs(['document:release-hold', '--tenant', 't-1'])).toThrow(
      'missing required --document',
    );
    expect(() => parseOpsArgs(['document:release-hold', '--document', 'd-1'])).toThrow(
      'missing required --tenant',
    );
    expect(() =>
      parseOpsArgs(['document:release-hold', '--tenant', 't', '--document', 'd', 'extra']),
    ).toThrow('unexpected positional argument (value hidden)');
  });
});
