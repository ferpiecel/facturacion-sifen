import { randomUUID } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  auditLog,
  createPgliteDatabase,
  webhookDeliveries,
  webhookEndpoints,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';

interface EndpointBody {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  secret_version: number;
  previous_secret_expires_at: string | null;
  secret?: string;
}

/** Spec: HU-E11-01 (S5). Webhook endpoint and delivery management through the real pipeline. */
describe('/v1/webhooks (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let owner: string;
  let readOnly: string;
  let other: string;
  let tenantId: string;

  async function seedTenant(name: string, scopes: string[]) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes,
    });
    return { id, key: formattedKey };
  }
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    key: string | null,
    payload?: object,
  ) => app.inject({ method, url, payload, headers: key ? { authorization: `Bearer ${key}` } : {} });
  const create = (
    key = owner,
    body: object = { url: 'https://hooks.example.com/sifen', events: ['document.approved'] },
  ) => call('POST', '/v1/webhooks/endpoints', key, body);

  beforeEach(async () => {
    vi.stubEnv('SIFEN_ENVIRONMENT', 'production');
    handle = createPgliteDatabase();
    await handle.migrate();
    const a = await seedTenant('Acme SA', ['webhooks:write', 'webhooks:read']);
    [owner, tenantId] = [a.key, a.id];
    readOnly = (await seedTenant('Reader SA', ['webhooks:read'])).key;
    other = (await seedTenant('Other SA', ['webhooks:write', 'webhooks:read'])).key;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('requires an api key and the right scope', async () => {
    expect((await call('GET', '/v1/webhooks/endpoints', null)).statusCode).toBe(401);
    expect((await create(readOnly)).statusCode).toBe(403);
    expect((await call('GET', '/v1/webhooks/endpoints', readOnly)).statusCode).toBe(200);
    const writeOnly = (await seedTenant('Writer SA', ['webhooks:write'])).key;
    expect((await call('GET', '/v1/webhooks/endpoints', writeOnly)).statusCode).toBe(403);
  });

  it('creates an endpoint returning the secret once, stored only sealed, and audits it', async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    const body = response.json<EndpointBody>();
    expect(body).toMatchObject({
      url: 'https://hooks.example.com/sifen',
      events: ['document.approved'],
      active: true,
      secret_version: 1,
    });
    expect(body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const [row] = await handle.db.select().from(webhookEndpoints);
    expect(JSON.stringify(row)).not.toContain(body.secret);
    const audit = await handle.db.select().from(auditLog);
    expect(audit.map((a) => a.action)).toEqual(['webhook_endpoint.create']);
    expect(JSON.stringify(audit)).not.toContain(body.secret);
    const list = await call('GET', '/v1/webhooks/endpoints', owner);
    expect(list.json<EndpointBody[]>()).toHaveLength(1);
    expect(list.body).not.toContain('whsec_');
    expect(list.body).not.toContain('ciphertext');
  });

  it('keeps responses that carry a secret out of every cache', async () => {
    const created = await create();
    expect(created.headers['cache-control']).toBe('private, no-store');
    const { id } = created.json<EndpointBody>();
    const rotated = await call('POST', `/v1/webhooks/endpoints/${id}/rotate-secret`, owner);
    expect(rotated.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects an invalid url or events with 422 and every error', async () => {
    const response = await create(owner, { url: 'https://10.0.0.1/hook', events: ['nope'] });
    expect(response.statusCode).toBe(422);
    expect(
      response
        .json<{ errors: { field: string }[] }>()
        .errors.map((e) => e.field)
        .sort(),
    ).toEqual(['events', 'url']);
    expect((await create(owner, {})).statusCode).toBe(422);
    expect((await call('POST', '/v1/webhooks/endpoints', owner)).statusCode).toBe(422);
  });

  it('updates an endpoint and keeps tenants apart (404 for another tenant or an unknown id)', async () => {
    const { id } = (await create()).json<EndpointBody>();
    const patched = await call('PATCH', `/v1/webhooks/endpoints/${id}`, owner, {
      active: false,
      events: [],
    });
    expect(patched.json<EndpointBody>()).toMatchObject({ id, active: false, events: [] });
    expect(
      (await call('PATCH', `/v1/webhooks/endpoints/${id}`, other, { active: true })).statusCode,
    ).toBe(404);
    expect(
      (await call('PATCH', `/v1/webhooks/endpoints/${randomUUID()}`, owner, { active: true }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('PATCH', '/v1/webhooks/endpoints/not-a-uuid', owner, { active: true }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('PATCH', `/v1/webhooks/endpoints/${id}`, owner, { url: 'http://x.com' }))
        .statusCode,
    ).toBe(422);
    expect((await call('GET', '/v1/webhooks/endpoints', other)).json<EndpointBody[]>()).toEqual([]);
  });

  it('rotates the secret: a new one once, version 2, the old kept for the overlap', async () => {
    const created = (await create()).json<EndpointBody>();
    const rotated = await call('POST', `/v1/webhooks/endpoints/${created.id}/rotate-secret`, owner);
    expect(rotated.statusCode).toBe(200);
    const body = rotated.json<EndpointBody>();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.secret).not.toBe(created.secret);
    expect(body.secret_version).toBe(2);
    const hours = (Date.parse(body.previous_secret_expires_at as string) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
    expect(
      (await call('POST', `/v1/webhooks/endpoints/${created.id}/rotate-secret`, other)).statusCode,
    ).toBe(404);
    expect((await handle.db.select().from(auditLog)).map((a) => a.action)).toContain(
      'webhook_endpoint.rotate_secret',
    );
  });

  describe('deliveries', () => {
    let endpointId: string;
    const insert = async (over: Partial<typeof webhookDeliveries.$inferInsert> = {}) =>
      (
        await handle.db
          .insert(webhookDeliveries)
          .values({
            tenantId,
            endpointId,
            eventId: `evt_${randomUUID().replaceAll('-', '')}`,
            eventType: 'document.approved',
            payload: { data: { cdc: 'private' } },
            nextAttemptAt: new Date(),
            ...over,
          })
          .returning()
      )[0].id;

    beforeEach(async () => {
      endpointId = (await create()).json<EndpointBody>().id;
    });

    it('lists the history without payloads, filtered and paginated', async () => {
      await insert();
      const dead = await insert({
        status: 'dead',
        nextAttemptAt: null,
        attemptCount: 9,
        lastStatusCode: 500,
        lastError: 'HTTP 500',
      });
      await insert();
      const page = (
        await call('GET', `/v1/webhooks/deliveries?endpoint_id=${endpointId}&limit=2`, owner)
      ).json<{ items: { id: string }[]; next_cursor: string | null }>();
      expect(page.items).toHaveLength(2);
      expect(page.next_cursor).toEqual(expect.any(String));
      const rest = (
        await call(
          'GET',
          `/v1/webhooks/deliveries?limit=2&cursor=${page.next_cursor as string}`,
          owner,
        )
      ).json<{ items: unknown[]; next_cursor: null }>();
      expect(rest.items).toHaveLength(1);
      const filtered = await call('GET', '/v1/webhooks/deliveries?status=dead', owner);
      expect(filtered.json<{ items: object[] }>().items).toEqual([
        expect.objectContaining({
          id: dead,
          endpoint_id: endpointId,
          event_type: 'document.approved',
          status: 'dead',
          attempt_count: 9,
          last_status_code: 500,
          last_error: 'HTTP 500',
        }),
      ]);
      expect(filtered.body).not.toContain('private');
      expect((await call('GET', '/v1/webhooks/deliveries?status=bogus', owner)).statusCode).toBe(
        422,
      );
      expect(
        (await call('GET', '/v1/webhooks/deliveries', other)).json<{ items: unknown[] }>().items,
      ).toEqual([]);
    });

    it('hides whether a failure was a blocked address or a DNS failure (no internal probing)', async () => {
      await insert({ status: 'dead', nextAttemptAt: null, lastError: 'blocked_address' });
      await insert({ status: 'dead', nextAttemptAt: null, lastError: 'dns_failure' });
      await insert({ status: 'dead', nextAttemptAt: null, lastError: 'timeout' });
      const { items } = (await call('GET', '/v1/webhooks/deliveries', owner)).json<{
        items: { last_error: string }[];
      }>();
      expect(items.map((i) => i.last_error).sort()).toEqual([
        'timeout',
        'unreachable',
        'unreachable',
      ]);
    });

    it('answers 409 when replaying onto an inactive endpoint', async () => {
      const id = await insert({ status: 'dead', nextAttemptAt: null });
      await call('PATCH', `/v1/webhooks/endpoints/${endpointId}`, owner, { active: false });
      const response = await call('POST', `/v1/webhooks/deliveries/${id}/replay`, owner);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toBe('endpoint inactive');
    });

    it('replays a dead delivery once, keeping its attempts, and audits it', async () => {
      const id = await insert({ status: 'dead', nextAttemptAt: null, attemptCount: 9 });
      const replayed = await call('POST', `/v1/webhooks/deliveries/${id}/replay`, owner);
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json<{ status: string; attempt_count: number }>()).toMatchObject({
        status: 'pending',
        attempt_count: 9,
      });
      expect((await call('POST', `/v1/webhooks/deliveries/${id}/replay`, owner)).statusCode).toBe(
        409,
      );
      expect((await call('POST', `/v1/webhooks/deliveries/${id}/replay`, other)).statusCode).toBe(
        404,
      );
      expect(
        (await call('POST', `/v1/webhooks/deliveries/${randomUUID()}/replay`, owner)).statusCode,
      ).toBe(404);
      expect(
        (await call('POST', `/v1/webhooks/deliveries/${id}/replay`, readOnly)).statusCode,
      ).toBe(403);
      const [row] = await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, id));
      expect(row.status).toBe('pending');
      expect((await handle.db.select().from(auditLog)).map((a) => a.action)).toContain(
        'webhook_delivery.replay',
      );
    });
  });
});
