import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  receivedDocuments,
  tenantFiscalProfiles,
  webhookDeliveries,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { computeRucCheckDigit } from '../src/modules/fiscal-config/domain/ruc.js';
import { computeCdcCheckDigit } from '../src/modules/emission/domain/cdc.js';
import { createReceivedDocument } from '../src/modules/reception/domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from '../src/modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import { RECEPTION_STORAGE } from '../src/modules/reception/reception.tokens.js';

const GOLDEN = readFileSync(
  fileURLToPath(
    new URL('./fixtures/reception/sifen/factura_contado/documento.xml', import.meta.url),
  ),
);
const ISSUER = '80000000';
const ISSUER_RUC = `${ISSUER}-${String(computeRucCheckDigit(ISSUER))}`;
const ANONYMIZED_CDC = `${'0'.repeat(43)}1`;
const VALID_CDC = `${'0'.repeat(43)}${String(computeCdcCheckDigit('0'.repeat(43)))}`;
/** The golden document with a valid CDC: only the issuer RUC check digit still needs a fix. */
const GOLDEN_VALID_CDC = Buffer.from(
  GOLDEN.toString('utf8').replace(`Id="${ANONYMIZED_CDC}"`, `Id="${VALID_CDC}"`),
);
const DOCTYPE = (body: string) =>
  Buffer.from(`<?xml version="1.0"?><!DOCTYPE rDE [${body}]><rDE>&x;</rDE>`);
const RECEPTION_EVENTS = [
  'reception.document.confirmed',
  'reception.document.needs_review',
  'reception.document.extraction_failed',
  'reception.document.updated',
];

interface Body {
  id: string;
  status: string;
  version: number;
  is_own_receiver: boolean;
  needs_review_reasons: string[];
  cdc: string;
  code?: string;
  document_id?: string;
  current_version?: number;
  items: { position: number; subtotal: string }[];
  totals: { total_amount: string };
}
interface ListBody {
  items: { id: string }[];
}

/**
 * Spec: reception R4.7. Cross-endpoint journey, ingest edge cases (ported from project A's
 * `test_ingesta_xml`), tenant and scope isolation (`test_rls`), races and the webhook-silence rule.
 */
describe('reception (e2e consolidation)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let tenantB: string;
  let keyA: string;
  let keyB: string;
  let readOnlyA: string;
  let writeOnlyA: string;
  const kmsKey = randomBytes(32).toString('base64');

  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    key: string,
    payload?: object | Buffer,
    contentType = 'application/json',
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}`, 'content-type': contentType },
      payload: payload instanceof Buffer ? payload : JSON.stringify(payload),
    });
  const upload = (key: string, xml: Buffer) =>
    call('POST', '/v1/received-documents', key, xml, 'application/xml');
  const detail = async (key: string, id: string) =>
    (await call('GET', `/v1/received-documents/${id}`, key)).json<Body>();
  const outbox = (tenantId: string) =>
    handle.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
  const outboxTypes = async (tenantId: string) =>
    (await outbox(tenantId)).map((row) => row.eventType).sort();

  /** A needs_review document with two items whose declared total (100) is wrong. */
  const seed = async (tenantId: string) => {
    const id = randomUUID();
    await createDrizzleReceivedDocumentRepository(handle.db).create(tenantId, {
      document: createReceivedDocument({ id, tenantId, source: 'sifen_xml', isOwnReceiver: true }),
      header: {
        issuerRucBase: ISSUER,
        issuerRucDv: computeRucCheckDigit(ISSUER),
        issuerLegalName: 'ACME',
        establishmentCode: '001',
        expeditionPointCode: '001',
        documentNumber: '0000001',
        issuedAt: new Date('2026-11-06T00:00:00.000Z'),
        taxable10: '100000',
        vat10: '10000',
        totalAmount: '100',
      },
      items: [1, 2].map((position) => ({
        position,
        description: `Line ${String(position)}`,
        productCode: null,
        quantity: '1',
        unitOfMeasure: null,
        unitPrice: '55000',
        discount: null,
        subtotal: '55000',
        vatRate: 10 as const,
        taxableBase: null,
        vatAmount: null,
      })),
    });
    await handle.db
      .update(receivedDocuments)
      .set({
        status: 'needs_review',
        needsReview: true,
        needsReviewReasons: ['totals_blocks_sum_mismatch'],
      })
      .where(eq(receivedDocuments.id, id));
    return id;
  };

  beforeEach(async () => {
    vi.stubEnv('SIFEN_ENVIRONMENT', 'production');
    vi.stubEnv('KMS_LOCAL_MASTER_KEY', kmsKey);
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    tenantB = (await createTenant(handle.db, 'Beta SA')).id;
    const key = (tenantId: string, scopes: string[]) =>
      issueApiKey(handle.db, { tenantId, environment: 'live', scopes });
    const all = ['reception:write', 'reception:read', 'webhooks:write'];
    const a = await key(tenantA, all);
    keyA = a.formattedKey;
    keyB = (await key(tenantB, all)).formattedKey;
    readOnlyA = (await key(tenantA, ['reception:read'])).formattedKey;
    writeOnlyA = (await key(tenantA, ['reception:write'])).formattedKey;
    // The golden receiver is 80000001-8: tenant A is that receiver, tenant B is somebody else.
    await handle.db.insert(tenantFiscalProfiles).values([
      {
        tenantId: tenantA,
        rucBase: '80000001',
        rucDv: 8,
        legalName: 'Empresa SA',
        taxpayerType: 'persona_juridica',
      },
      {
        tenantId: tenantB,
        rucBase: '80000002',
        rucDv: computeRucCheckDigit('80000002'),
        legalName: 'Otra SA',
        taxpayerType: 'persona_juridica',
      },
    ] as (typeof tenantFiscalProfiles.$inferInsert)[]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RECEPTION_STORAGE)
      .useValue(new InMemoryStorageProvider())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const endpoint = { url: 'https://erp.example.com/hooks', events: RECEPTION_EVENTS };
    await call('POST', '/v1/webhooks/endpoints', keyA, endpoint);
    await call('POST', '/v1/webhooks/endpoints', keyB, endpoint);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  describe('ERP journey', () => {
    it('upload -> detail with reasons -> blocked confirm -> correct and confirm -> events', async () => {
      expect(GOLDEN_VALID_CDC.equals(GOLDEN)).toBe(false);
      const uploaded = await upload(keyA, GOLDEN);
      expect(uploaded.statusCode).toBe(202);
      const { id } = uploaded.json<Body>();
      const before = await detail(keyA, id);
      expect(before).toMatchObject({ status: 'needs_review', version: 1, is_own_receiver: true });
      // The golden CDC and issuer DV are anonymized: those are the review reasons.
      expect(before.needs_review_reasons).toEqual(
        expect.arrayContaining(['issuer_ruc_check_digit_mismatch', 'cdc_check_digit_mismatch']),
      );
      // The CDC is identity and cannot be corrected, so this document stays blocked (documented).
      const blocked = await call('PATCH', `/v1/received-documents/${id}`, keyA, {
        version: 1,
        confirm: true,
        issuer: { ruc: ISSUER_RUC },
      });
      expect(blocked.statusCode).toBe(422);
      expect(blocked.json<Body>()).toMatchObject({ code: 'validation_failed' });
      expect(await detail(keyA, id)).toMatchObject({ status: 'needs_review', version: 1 });
      expect(await outboxTypes(tenantA)).toEqual(['reception.document.needs_review']);
    });

    it('a document with a valid CDC is corrected and confirmed in one call', async () => {
      const { id } = (await upload(keyA, GOLDEN_VALID_CDC)).json<Body>();
      const before = await detail(keyA, id);
      expect(before).toMatchObject({ status: 'needs_review', version: 1, cdc: VALID_CDC });
      expect(before.needs_review_reasons).toEqual(['issuer_ruc_check_digit_mismatch']);
      expect(await outboxTypes(tenantA)).toEqual(['reception.document.needs_review']);

      const confirmed = await call('PATCH', `/v1/received-documents/${id}`, keyA, {
        version: 1,
        confirm: true,
        issuer: { ruc: ISSUER_RUC },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json<Body>()).toMatchObject({ id, status: 'confirmed', version: 2 });
      expect(await detail(keyA, id)).toMatchObject({
        status: 'confirmed',
        version: 2,
        needs_review_reasons: [],
      });
      expect(await outboxTypes(tenantA)).toEqual([
        'reception.document.confirmed',
        'reception.document.needs_review',
      ]);
      const listed = (
        await call('GET', '/v1/received-documents?status=confirmed', keyA)
      ).json<ListBody>();
      expect(listed.items.map((item) => item.id)).toEqual([id]);
    });
  });

  describe('ingest', () => {
    it('flags a document for another receiver, keeping the matching one own', async () => {
      const own = (await upload(keyA, GOLDEN)).json<Body>();
      const other = (await upload(keyB, GOLDEN)).json<Body>();
      expect(await detail(keyA, own.id)).toMatchObject({ is_own_receiver: true });
      expect(await detail(keyB, other.id)).toMatchObject({ is_own_receiver: false });
    });

    it('a duplicate upload answers 200 with the same id and creates no second row', async () => {
      const first = await upload(keyA, GOLDEN);
      const again = await upload(keyA, GOLDEN);
      expect(first.statusCode).toBe(202);
      expect(again.statusCode).toBe(200);
      expect(again.json<Body>().id).toBe(first.json<Body>().id);
      expect(await handle.db.select().from(receivedDocuments)).toHaveLength(1);
    });

    it('the same CDC with different bytes answers 200 with the first document', async () => {
      const first = (await upload(keyA, GOLDEN)).json<Body>();
      const resigned = Buffer.from(`${GOLDEN.toString('utf8')}\n<!-- re-signed -->`);
      const again = await upload(keyA, resigned);
      expect(again.statusCode).toBe(200);
      expect(again.json<Body>().id).toBe(first.id);
      expect(await handle.db.select().from(receivedDocuments)).toHaveLength(1);
    });

    it('malformed XML answers 422 extraction_failed and its stored artifact stays retrievable', async () => {
      const bytes = Buffer.from('<rDE><broken');
      const response = await upload(keyA, bytes);
      expect(response.statusCode).toBe(422);
      expect(response.json<Body>().code).toBe('extraction_failed');
      const id = response.json<Body>().document_id ?? '';
      expect(await detail(keyA, id)).toMatchObject({ status: 'extraction_failed' });
      const artifact = await call('GET', `/v1/received-documents/${id}/artifact`, keyA);
      expect(artifact.statusCode).toBe(200);
      expect(artifact.rawPayload.equals(bytes)).toBe(true);
    });

    it.each([
      ['an external entity (XXE)', DOCTYPE('<!ENTITY x SYSTEM "file:///etc/passwd">')],
      [
        'an entity expansion bomb',
        DOCTYPE(
          '<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY x "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">',
        ),
      ],
    ])('rejects a DTD upload with %s without leaking anything', async (_name, xml) => {
      const response = await upload(keyA, xml);
      expect(response.statusCode).toBe(422);
      expect(response.json<Body>().code).toBe('extraction_failed');
      expect(response.body).not.toMatch(/root:|passwd|aaaa/);
    });

    it('rejects an oversized upload with 413 and stores nothing', async () => {
      const huge = Buffer.concat([Buffer.from('<a>'), Buffer.alloc(2 * 1024 * 1024, 0x20)]);
      const response = await upload(keyA, huge);
      expect(response.statusCode).toBe(413);
      expect(response.json<Body>().code).toBe('payload_too_large');
      expect(await handle.db.select().from(receivedDocuments)).toHaveLength(0);
    });
  });

  describe('tenant and scope isolation', () => {
    it("tenant B cannot read, patch or fetch the artifact of tenant A's document", async () => {
      const { id } = (await upload(keyA, GOLDEN)).json<Body>();
      for (const suffix of ['', '/artifact', '/artifact-url']) {
        const response = await call('GET', `/v1/received-documents/${id}${suffix}`, keyB);
        expect(response.statusCode, suffix).toBe(404);
        expect(response.json<Body>().code).toBe('not_found');
      }
      const patch = await call('PATCH', `/v1/received-documents/${id}`, keyB, {
        version: 1,
        confirm: true,
      });
      expect(patch.statusCode).toBe(404);
      expect(await detail(keyA, id)).toMatchObject({ status: 'needs_review', version: 1 });
    });

    it('the same bytes uploaded by tenant B create their own document; lists never leak', async () => {
      const a = (await upload(keyA, GOLDEN)).json<Body>();
      const b = await upload(keyB, GOLDEN);
      expect(b.statusCode).toBe(202);
      expect(b.json<Body>().id).not.toBe(a.id);
      const listA = (await call('GET', '/v1/received-documents', keyA)).json<ListBody>();
      const listB = (await call('GET', '/v1/received-documents', keyB)).json<ListBody>();
      expect(listA.items.map((item) => item.id)).toEqual([a.id]);
      expect(listB.items.map((item) => item.id)).toEqual([b.json<Body>().id]);
      const rows = await handle.db.select().from(receivedDocuments);
      expect(rows.map((row) => row.tenantId).sort()).toEqual([tenantA, tenantB].sort());
    });

    it('enforces the scopes: read-only cannot write, write-only cannot read', async () => {
      const { id } = (await upload(keyA, GOLDEN)).json<Body>();
      expect((await upload(readOnlyA, GOLDEN)).statusCode).toBe(403);
      expect(
        (await call('PATCH', `/v1/received-documents/${id}`, readOnlyA, { version: 1 })).statusCode,
      ).toBe(403);
      for (const suffix of ['', `/${id}`, `/${id}/artifact`, `/${id}/artifact-url`]) {
        expect((await call('GET', `/v1/received-documents${suffix}`, writeOnlyA)).statusCode).toBe(
          403,
        );
      }
      expect((await call('GET', `/v1/received-documents/${id}`, readOnlyA)).statusCode).toBe(200);
      expect((await upload(writeOnlyA, GOLDEN)).statusCode).toBe(200);
    });
  });

  describe('concurrency', () => {
    it('two PATCH with the same version: exactly one wins, the other gets 409 version_conflict', async () => {
      const id = await seed(tenantA);
      const patch = (name: string) =>
        call('PATCH', `/v1/received-documents/${id}`, keyA, {
          version: 1,
          issuer: { trade_name: name },
        });
      const results = await Promise.all([patch('ONE'), patch('TWO')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.statusCode === 409);
      expect(loser?.json<Body>()).toMatchObject({ code: 'version_conflict', current_version: 2 });
      expect((await detail(keyA, id)).version).toBe(2);
    });
  });

  describe('removed items', () => {
    it('are excluded from the detail and cannot be brought back', async () => {
      const id = await seed(tenantA);
      const removed = await call('PATCH', `/v1/received-documents/${id}`, keyA, {
        version: 1,
        items: [{ position: 2, remove: true }],
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json<Body>().items.map((item) => item.position)).toEqual([1]);
      expect((await detail(keyA, id)).items.map((item) => item.position)).toEqual([1]);

      const revive = await call('PATCH', `/v1/received-documents/${id}`, keyA, {
        version: 2,
        items: [{ position: 2, description: 'Back again' }],
      });
      expect(revive.statusCode).toBe(422);
      expect(revive.json<Body>().code).toBe('invalid_correction');
      const after = await detail(keyA, id);
      expect(after.version).toBe(2);
      expect(after.items.map((item) => item.position)).toEqual([1]);
    });

    it('stay out of the confirmation arithmetic', async () => {
      const id = await seed(tenantA);
      // Remaining item 1 (55000 -> 110000) must match the total; the removed item 2 is ignored.
      const response = await call('PATCH', `/v1/received-documents/${id}`, keyA, {
        version: 1,
        confirm: true,
        totals: { total_amount: '110000' },
        items: [
          { position: 1, subtotal: '110000' },
          { position: 2, remove: true },
        ],
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = await detail(keyA, id);
      expect(body.status).toBe('confirmed');
      expect(body.items).toEqual([expect.objectContaining({ position: 1, subtotal: '110000' })]);
    });
  });

  describe('webhook silence for another receiver', () => {
    it('yields no outbox rows through upload, correction, confirmation and a later edit', async () => {
      const { id } = (await upload(keyB, GOLDEN_VALID_CDC)).json<Body>();
      expect((await detail(keyB, id)).is_own_receiver).toBe(false);
      expect(
        (
          await call('PATCH', `/v1/received-documents/${id}`, keyB, {
            version: 1,
            confirm: true,
            issuer: { ruc: ISSUER_RUC },
          })
        ).statusCode,
      ).toBe(200);
      expect((await detail(keyB, id)).status).toBe('confirmed');
      expect(
        (
          await call('PATCH', `/v1/received-documents/${id}`, keyB, {
            version: 2,
            issuer: { trade_name: 'ACME SRL' },
          })
        ).statusCode,
      ).toBe(200);
      expect(await outbox(tenantB)).toHaveLength(0);
      // Controls: the own receiver does enqueue, and so does an unreadable XML (documented as own).
      await upload(keyA, GOLDEN_VALID_CDC);
      expect(await outboxTypes(tenantA)).toEqual(['reception.document.needs_review']);
      expect((await upload(keyB, Buffer.from('<rDE><broken'))).statusCode).toBe(422);
      expect(await outboxTypes(tenantB)).toEqual(['reception.document.extraction_failed']);
    });
  });
});
