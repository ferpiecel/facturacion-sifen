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
import type { WebhookHttpPort } from '../src/modules/webhooks/application/ports/webhook-http.port.js';
import { verifyWebhookSignature } from '../src/modules/webhooks/domain/webhook-signature.js';
import { createReceivedDocument } from '../src/modules/reception/domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from '../src/modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import { RECEPTION_STORAGE } from '../src/modules/reception/reception.tokens.js';
import {
  createWebhookDeliveryDeps,
  createWebhookDeliveryProcessor,
} from '../src/worker/webhook-delivery.processor.js';

const GOLDEN = readFileSync(
  fileURLToPath(
    new URL('./fixtures/reception/sifen/factura_contado/documento.xml', import.meta.url),
  ),
);
const ISSUER = '80000000';
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
  needs_review_reasons: string[];
}
interface EventBody {
  id: string;
  type: string;
  tenant_id: string;
  data: Record<string, unknown>;
}

/** Spec: reception R4.5 (ADR-0023). Reception events reach the webhook outbox and the delivery path. */
describe('reception webhook events (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let tenantA: string;
  let tenantB: string;
  let keyA: string;
  let keyAId: string;
  let keyB: string;
  let secretA: string;
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
  const rows = (tenantId: string) =>
    handle.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId));
  const typesOf = async (tenantId: string) =>
    (await rows(tenantId)).map((row) => row.eventType).sort();

  /** A needs_review document whose declared total (100) disagrees with its blocks (110000). */
  const seed = async (tenantId: string, isOwnReceiver = true) => {
    const id = randomUUID();
    await createDrizzleReceivedDocumentRepository(handle.db).create(tenantId, {
      document: createReceivedDocument({ id, tenantId, source: 'sifen_xml', isOwnReceiver }),
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
      items: [1].map((position) => ({
        position,
        description: 'Line',
        productCode: null,
        quantity: '1',
        unitOfMeasure: null,
        unitPrice: '110000',
        discount: null,
        subtotal: '110000',
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
    const scopes = ['reception:write', 'reception:read', 'webhooks:write'];
    const a = await issueApiKey(handle.db, { tenantId: tenantA, environment: 'live', scopes });
    [keyA, keyAId] = [a.formattedKey, a.apiKeyId];
    keyB = (await issueApiKey(handle.db, { tenantId: tenantB, environment: 'live', scopes }))
      .formattedKey;
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
    secretA = (await call('POST', '/v1/webhooks/endpoints', keyA, endpoint)).json<{
      secret: string;
    }>().secret;
    await call('POST', '/v1/webhooks/endpoints', keyB, endpoint);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('upload that needs review enqueues needs_review with reason codes and no fiscal data', async () => {
    const response = await upload(keyA, GOLDEN);
    expect(response.statusCode).toBe(202);
    const doc = response.json<Body>();
    const [row] = await rows(tenantA);
    expect(row.eventType).toBe('reception.document.needs_review');
    const event = row.payload as EventBody;
    expect(event.data).toMatchObject({
      document_id: doc.id,
      status: 'needs_review',
      version: 1,
      links: { self: `/v1/received-documents/${doc.id}` },
    });
    const reasons = event.data.reasons as string[];
    expect(reasons.length).toBeGreaterThan(0);
    expect(
      (await call('GET', `/v1/received-documents/${doc.id}`, keyA)).json<Body>()
        .needs_review_reasons,
    ).toEqual(reasons);
    // Minimal by contract: nothing of the document content (RUC, names, amounts, CDC) leaks.
    const text = JSON.stringify(event);
    for (const secret of ['80000001', 'Empresa', '110000']) expect(text).not.toContain(secret);
    expect(Object.keys(event.data).sort()).toEqual([
      'document_id',
      'links',
      'reasons',
      'status',
      'version',
    ]);
  });

  it('an upload replay does not duplicate the event', async () => {
    await upload(keyA, GOLDEN);
    expect((await upload(keyA, GOLDEN)).statusCode).toBe(200);
    expect(await typesOf(tenantA)).toEqual(['reception.document.needs_review']);
  });

  it('a document for another receiver is stored but enqueues nothing, for any event type', async () => {
    expect((await upload(keyB, GOLDEN)).statusCode).toBe(202);
    expect(await rows(tenantB)).toHaveLength(0);
    // Confirming and then editing such a document stays silent too.
    const id = await seed(tenantB, false);
    for (const body of [
      { version: 1, confirm: true, totals: { total_amount: '110000' } },
      { version: 2, issuer: { trade_name: 'ACME SRL' } },
    ]) {
      expect((await call('PATCH', `/v1/received-documents/${id}`, keyB, body)).statusCode).toBe(
        200,
      );
    }
    expect(await rows(tenantB)).toHaveLength(0);
  });

  it('an unreadable XML enqueues extraction_failed', async () => {
    expect((await upload(keyA, Buffer.from('<rDE><broken'))).statusCode).toBe(422);
    expect(await typesOf(tenantA)).toEqual(['reception.document.extraction_failed']);
  });

  it('correct + confirm enqueues confirmed; a later edit enqueues updated with actor and version', async () => {
    const id = await seed(tenantA);
    const confirm = await call('PATCH', `/v1/received-documents/${id}`, keyA, {
      version: 1,
      confirm: true,
      totals: { total_amount: '110000' },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(await typesOf(tenantA)).toEqual(['reception.document.confirmed']);

    const edit = await call('PATCH', `/v1/received-documents/${id}`, keyA, {
      version: 2,
      issuer: { trade_name: 'ACME SRL' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json<Body>().version).toBe(3);
    // Replaying the edit (same request, same actor) writes and enqueues nothing more.
    expect(
      (
        await call('PATCH', `/v1/received-documents/${id}`, keyA, {
          version: 2,
          issuer: { trade_name: 'ACME SRL' },
        })
      ).headers['idempotent-replayed'],
    ).toBe('true');

    const all = await rows(tenantA);
    expect(all.map((row) => row.eventType).sort()).toEqual([
      'reception.document.confirmed',
      'reception.document.updated',
    ]);
    const updated = all.find((row) => row.eventType === 'reception.document.updated')
      ?.payload as EventBody;
    // The echo of the ERP's own write: same API key id and the version it just wrote.
    expect(updated.data).toMatchObject({
      document_id: id,
      status: 'confirmed',
      version: 3,
      actor: { type: 'api_key', id: keyAId },
    });
  });

  it('delivers the confirmed event, signed, through the worker delivery path', async () => {
    const id = await seed(tenantA);
    await call('PATCH', `/v1/received-documents/${id}`, keyA, {
      version: 1,
      confirm: true,
      totals: { total_amount: '110000' },
    });
    const { vault } = createWebhookDeliveryDeps({
      KMS_LOCAL_MASTER_KEY: kmsKey,
      NODE_ENV: 'production',
    });
    const post = vi.fn<WebhookHttpPort['post']>(() =>
      Promise.resolve({ kind: 'response', status: 200 }),
    );
    const summary = await createWebhookDeliveryProcessor({
      db: handle.db,
      vault,
      http: { post },
      now: () => new Date(Date.now() + 1000),
    })({ data: { tenantId: tenantA } });
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    const request = post.mock.calls[0][0];
    expect(request.url).toBe('https://erp.example.com/hooks');
    expect(
      verifyWebhookSignature({
        secret: secretA,
        body: request.body,
        header: request.headers['sifen-signature'],
        now: Math.floor(Date.now() / 1000) + 1,
      }).ok,
    ).toBe(true);
    expect(JSON.parse(request.body)).toMatchObject({
      type: 'reception.document.confirmed',
      tenant_id: tenantA,
      data: { document_id: id, status: 'confirmed', version: 2 },
    });
  });
});
