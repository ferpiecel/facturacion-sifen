import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvelopeCipher } from '../../custody/application/envelope-cipher.js';
import type {
  DataKey,
  KeyManagementService,
} from '../../custody/application/ports/key-management.port.js';
import { WebhookSecretVault } from '../../custody/application/webhook-secret-vault.js';
import type { SealedSecret } from '../../custody/domain/sealed-secret.js';
import type { EndpointView, WebhookEndpointStore } from './ports/webhook-endpoint-store.port.js';
import {
  WebhookEndpointNotFoundError,
  WebhookValidationError,
  createWebhookEndpointService,
} from './webhook-endpoints.js';

const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
const kms: KeyManagementService = {
  generateDataKey(): Promise<DataKey> {
    const plaintextKey = randomBytes(32);
    return Promise.resolve({ plaintextKey, wrappedKey: xor(plaintextKey), keyId: 'fake:1' });
  },
  unwrapDataKey: (wrapped) => Promise.resolve(xor(wrapped)),
};
const vault = new WebhookSecretVault(new EnvelopeCipher(kms));

const NOW = new Date('2026-10-01T12:00:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = { type: 'api_key', id: 'key-1' } as const;
const ID = '22222222-2222-4222-8222-222222222222';

type Row = EndpointView & { sealed: SealedSecret; previousSealed: SealedSecret | null };

function fakeStore() {
  const rows = new Map<string, Row>();
  const view = (r: Row): EndpointView =>
    ({ ...r, sealed: undefined, previousSealed: undefined }) as unknown as EndpointView;
  const store: WebhookEndpointStore = {
    insert: (_t, _a, row) => {
      const r = {
        ...row,
        active: true,
        secretVersion: 1,
        previousExpiresAt: null,
        previousSealed: null,
        createdAt: NOW,
        updatedAt: NOW,
      } as Row;
      rows.set(r.id, r);
      return Promise.resolve(view(r));
    },
    list: () => Promise.resolve([...rows.values()].map(view)),
    find: (_t, id) => Promise.resolve(rows.get(id) ?? null),
    update: (_t, _a, id, patch) => {
      const r = rows.get(id);
      if (!r) return Promise.resolve(null);
      Object.assign(r, patch);
      return Promise.resolve(view(r));
    },
    rotate: (_t, _a, id, change) => {
      const r = rows.get(id);
      if (r?.secretVersion !== change.expectedVersion) return Promise.resolve('stale');
      Object.assign(r, {
        sealed: change.sealed,
        previousSealed: change.previousSealed,
        previousExpiresAt: change.previousExpiresAt,
        secretVersion: change.expectedVersion + 1,
      });
      return Promise.resolve(view(r));
    },
  };
  return { store, rows };
}

function setup(secrets: string[] = ['whsec_generated']) {
  const { store, rows } = fakeStore();
  const queue = [...secrets];
  const service = createWebhookEndpointService({
    store,
    vault,
    now: () => NOW,
    newId: () => ID,
    generateSecret: () => queue.shift() as string,
  });
  return { service, rows };
}

/** Spec: HU-E11-01 (S5). Endpoint registration and rotation over a store port. */
describe('webhook endpoint service', () => {
  it('creates an endpoint, sealing the generated secret under the identity the dispatcher opens', async () => {
    const { service, rows } = setup();
    const created = await service.create(TENANT, ACTOR, {
      url: 'https://hooks.example.com/x',
      events: ['document.approved'],
    });
    expect(created.secret).toBe('whsec_generated');
    expect(created.endpoint).toMatchObject({
      id: ID,
      url: 'https://hooks.example.com/x',
      events: ['document.approved'],
      active: true,
      secretVersion: 1,
    });
    expect(JSON.stringify(created.endpoint)).not.toContain('whsec_');
    const row = rows.get(ID) as Row;
    expect(JSON.stringify(row.sealed)).not.toContain('whsec_generated');
    expect(
      await vault.signingSecrets({
        tenantId: TENANT,
        endpointId: ID,
        secretVersion: 1,
        sealed: row.sealed,
        previousSealed: null,
        previousExpiresAt: null,
        now: NOW,
      }),
    ).toEqual(['whsec_generated']);
  });

  it('refuses invalid input with every error listed and stores nothing', async () => {
    const { service, rows } = setup();
    const error = await service
      .create(TENANT, ACTOR, { url: 'http://127.0.0.1', events: ['nope'] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookValidationError);
    expect((error as WebhookValidationError).errors.map((e) => e.field).sort()).toEqual([
      'events',
      'url',
    ]);
    expect(rows.size).toBe(0);
  });

  it('rotates: version + 1, new secret once, old one kept for 24 hours', async () => {
    const { service, rows } = setup(['whsec_generated', 'whsec_second']);
    await service.create(TENANT, ACTOR, { url: 'https://hooks.example.com/x', events: [] });
    const first = rows.get(ID) as Row;
    const old = first.sealed;
    const rotated = await service.rotate(TENANT, ACTOR, ID);
    expect(rotated.secret).toBe('whsec_second');
    expect(rotated.endpoint).toMatchObject({
      secretVersion: 2,
      previousExpiresAt: new Date(NOW.getTime() + 24 * 3_600_000),
    });
    const row = rows.get(ID) as Row;
    expect(row.previousSealed).toEqual(old);
    expect(
      await vault.signingSecrets({
        tenantId: TENANT,
        endpointId: ID,
        secretVersion: 2,
        sealed: row.sealed,
        previousSealed: row.previousSealed,
        previousExpiresAt: row.previousExpiresAt,
        now: NOW,
      }),
    ).toEqual(['whsec_second', 'whsec_generated']);
  });

  it('reports an unknown endpoint and a lost rotation race', async () => {
    const { service } = setup();
    await expect(service.rotate(TENANT, ACTOR, ID)).rejects.toBeInstanceOf(
      WebhookEndpointNotFoundError,
    );
    await expect(service.update(TENANT, ACTOR, ID, { active: false })).rejects.toBeInstanceOf(
      WebhookEndpointNotFoundError,
    );
  });

  it('updates url, events and active with the same validation', async () => {
    const { service } = setup();
    await service.create(TENANT, ACTOR, { url: 'https://hooks.example.com/x', events: [] });
    expect(
      await service.update(TENANT, ACTOR, ID, { active: false, events: ['document.rejected'] }),
    ).toMatchObject({ active: false, events: ['document.rejected'] });
    await expect(
      service.update(TENANT, ACTOR, ID, { url: 'https://10.0.0.1/' }),
    ).rejects.toBeInstanceOf(WebhookValidationError);
    expect(await service.list(TENANT)).toHaveLength(1);
  });
});
