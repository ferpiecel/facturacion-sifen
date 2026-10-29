import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  createPgliteDatabase,
  documentCorrectionClaims,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { requestHash } from '../modules/emission/domain/request-hash.js';
import { parseOpsArgs } from './args.js';
import { releaseCorrectionClaim } from './correction-claim-commands.js';
import { runOpsCommand } from './ops.js';

/** Spec: HU-E8-01, ADR-0021. Operator command that releases a stale correction claim. */
describe('correction:release-claim', () => {
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
    const document = async (n: number, idempotencyKey: string | null = null) =>
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
            idempotencyKey,
            requestHash: idempotencyKey === null ? null : 'a'.repeat(64),
          })
          .returning()
      )[0].id;
    const rejected = await document(1);
    await db.insert(documentCorrectionClaims).values({
      tenantId: a.id,
      documentId: rejected,
      idempotencyKey: 'fix-1',
      requestHash: 'b'.repeat(64),
    });
    return { db, tenantId: a.id, otherTenantId: b.id, rejected, document };
  }

  const claimOf = (db: DatabaseHandle['db'], documentId: string) =>
    db
      .select()
      .from(documentCorrectionClaims)
      .where(eq(documentCorrectionClaims.documentId, documentId));

  it('deletes the claim and audits who released it', async () => {
    const { db, tenantId, rejected } = await seed();

    await expect(
      releaseCorrectionClaim(db, { tenantId, documentId: rejected, actor: 'ana' }),
    ).resolves.toEqual({ documentId: rejected, idempotencyKey: 'fix-1' });

    expect(await claimOf(db, rejected)).toEqual([]);
    const entries = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'correction.claim_released')),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorType: 'operator',
      actorId: 'ana',
      entityId: rejected,
      before: { idempotencyKey: 'fix-1' },
    });
  });

  it('refuses when the replacement already exists, leaving the claim in place', async () => {
    const { db, tenantId, rejected, document } = await seed();
    await document(2, `${requestHash({ reissueOf: rejected })}:reissue`);

    await expect(
      releaseCorrectionClaim(db, { tenantId, documentId: rejected, actor: 'ana' }),
    ).rejects.toThrow(`a replacement already exists for document ${rejected}`);

    expect(await claimOf(db, rejected)).toHaveLength(1);
  });

  it('refuses a document without a claim and one of another tenant', async () => {
    const { db, tenantId, otherTenantId, rejected } = await seed();
    await releaseCorrectionClaim(db, { tenantId, documentId: rejected, actor: 'ana' });

    await expect(
      releaseCorrectionClaim(db, { tenantId, documentId: rejected, actor: 'ana' }),
    ).rejects.toThrow(`document has no correction claim: ${rejected}`);
    await expect(
      releaseCorrectionClaim(db, { tenantId: otherTenantId, documentId: rejected, actor: 'ana' }),
    ).rejects.toThrow(`document not found: ${rejected}`);
  });

  it('parses strictly and runs through the dispatcher', async () => {
    expect(
      parseOpsArgs([
        'correction:release-claim',
        '--tenant',
        't-1',
        '--document',
        'd-1',
        '--actor',
        'ana',
      ]),
    ).toEqual({
      kind: 'correction:release-claim',
      tenantId: 't-1',
      documentId: 'd-1',
      actor: 'ana',
    });
    expect(() =>
      parseOpsArgs(['correction:release-claim', '--tenant', 't-1', '--document', 'd-1']),
    ).toThrow(/--actor/);
    expect(() =>
      parseOpsArgs(['correction:release-claim', '--document', 'd-1', '--actor', 'ana']),
    ).toThrow(/--tenant/);

    const { db, tenantId, rejected } = await seed();
    await expect(
      runOpsCommand(db, {
        kind: 'correction:release-claim',
        tenantId,
        documentId: rejected,
        actor: 'ana',
      }),
    ).resolves.toBe(`correction claim released: ${rejected} (key fix-1)`);
  });
});
