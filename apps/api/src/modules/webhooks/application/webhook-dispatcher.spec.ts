import { describe, expect, it, vi } from 'vitest';
import type { WebhookSecretVault } from '../../custody/application/webhook-secret-vault.js';
import { nextRetryAt, RETRY_WINDOW_MS } from '../domain/webhook-backoff.js';
import { verifyWebhookSignature } from '../domain/webhook-signature.js';
import type {
  DueWebhookDelivery,
  WebhookAttemptOutcome,
  WebhookDeliveryStore,
} from './ports/webhook-delivery-store.port.js';
import type { WebhookHttpPort, WebhookHttpResult } from './ports/webhook-http.port.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const payload = {
  id: 'evt_00000001',
  type: 'document.approved',
  created_at: NOW.toISOString(),
  tenant_id: 't',
  data: { cdc: '1' },
};

const delivery = (over: Partial<DueWebhookDelivery> = {}): DueWebhookDelivery => ({
  id: 'd1',
  tenantId: 't',
  endpointId: 'e1',
  url: 'https://hooks.example.com/sifen',
  payload,
  attemptCount: 0,
  firstAttemptAt: null,
  secret: { version: 1, sealed: SEALED, previousSealed: null, previousExpiresAt: null },
  ...over,
});

function setup(
  due: DueWebhookDelivery[],
  result: WebhookHttpResult | (() => Promise<WebhookHttpResult>) = {
    kind: 'response',
    status: 200,
  },
  secrets: string[] | Error = ['whsec_a'],
) {
  const recorded: { id: string; outcome: WebhookAttemptOutcome }[] = [];
  const store: WebhookDeliveryStore = {
    claimDue: vi.fn(() => Promise.resolve(due)),
    record: vi.fn((id, outcome) => {
      recorded.push({ id, outcome });
      return Promise.resolve();
    }),
  };
  const post = vi.fn(typeof result === 'function' ? result : () => Promise.resolve(result));
  const http: WebhookHttpPort = { post };
  const vault = {
    signingSecrets: vi.fn(() =>
      secrets instanceof Error ? Promise.reject(secrets) : Promise.resolve(secrets),
    ),
  } as unknown as Pick<WebhookSecretVault, 'signingSecrets'>;
  let now = NOW;
  const dispatcher = new WebhookDispatcher({
    store,
    http,
    vault,
    now: () => now,
    random: () => 0.5,
    batchSize: 10,
  });
  return { dispatcher, store, post, vault, recorded, setNow: (d: Date) => (now = d) };
}

describe('WebhookDispatcher (HU-E11-01)', () => {
  it('claims a bounded batch with a lease', async () => {
    const { dispatcher, store } = setup([]);
    expect(await dispatcher.runOnce()).toEqual({
      claimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      unrecorded: 0,
    });
    expect(store.claimDue).toHaveBeenCalledWith(NOW, 10, 120_000);
  });

  it('signs the frozen payload with a fresh timestamp and marks a 2xx delivered', async () => {
    const { dispatcher, post, recorded } = setup([delivery()]);
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, delivered: 1 });
    const request = post.mock.calls[0][0];
    expect(request.url).toBe('https://hooks.example.com/sifen');
    expect(request.body).toBe(JSON.stringify(payload));
    expect(request.headers['content-type']).toBe('application/json');
    expect(
      verifyWebhookSignature({
        secret: 'whsec_a',
        body: request.body,
        header: request.headers['sifen-signature'],
        now: NOW.getTime() / 1000,
      }),
    ).toEqual({ ok: true });
    expect(recorded[0]).toEqual({
      id: 'd1',
      outcome: {
        status: 'delivered',
        attemptCount: 1,
        firstAttemptAt: NOW,
        lastAttemptAt: NOW,
        nextAttemptAt: null,
        deliveredAt: NOW,
        lastStatusCode: 200,
        lastError: null,
      },
    });
  });

  it('re-signs every attempt with the clock at that moment', async () => {
    const { dispatcher, post, setNow } = setup([delivery()]);
    await dispatcher.runOnce();
    setNow(new Date(NOW.getTime() + 90_000));
    await dispatcher.runOnce();
    const stamp = (i: number) =>
      /^t=(\d+)/.exec(post.mock.calls[i][0].headers['sifen-signature'])?.[1];
    expect(Number(stamp(1)) - Number(stamp(0))).toBe(90);
  });

  it('signs with both secrets while a rotation overlaps', async () => {
    const { dispatcher, post } = setup([delivery()], undefined, ['whsec_new', 'whsec_old']);
    await dispatcher.runOnce();
    const request = post.mock.calls[0][0];
    for (const secret of ['whsec_new', 'whsec_old']) {
      expect(
        verifyWebhookSignature({
          secret,
          body: request.body,
          header: request.headers['sifen-signature'],
          now: NOW.getTime() / 1000,
        }).ok,
      ).toBe(true);
    }
  });

  it.each([500, 302, 404, 199])('retries on HTTP %i with the backoff schedule', async (status) => {
    const { dispatcher, recorded } = setup([delivery({ attemptCount: 2, firstAttemptAt: NOW })], {
      kind: 'response',
      status,
    });
    expect(await dispatcher.runOnce()).toMatchObject({ retried: 1, delivered: 0 });
    expect(recorded[0].outcome).toEqual({
      status: 'failed',
      attemptCount: 3,
      firstAttemptAt: NOW,
      lastAttemptAt: NOW,
      nextAttemptAt: nextRetryAt({
        firstAttemptAt: NOW,
        now: NOW,
        failedAttempts: 3,
        random: () => 0.5,
      }),
      deliveredAt: null,
      lastStatusCode: status,
      lastError: `HTTP ${String(status)}`,
    });
  });

  it('records a transport error by its code, without a status', async () => {
    const { dispatcher, recorded } = setup([delivery()], {
      kind: 'error',
      code: 'blocked_address',
    });
    await dispatcher.runOnce();
    expect(recorded[0].outcome).toMatchObject({
      status: 'failed',
      lastStatusCode: null,
      lastError: 'blocked_address',
      firstAttemptAt: NOW,
    });
  });

  it('dead-letters once the 24 hour window is exhausted', async () => {
    const first = new Date(NOW.getTime() - RETRY_WINDOW_MS - 1);
    const { dispatcher, recorded } = setup(
      [delivery({ attemptCount: 14, firstAttemptAt: first })],
      { kind: 'response', status: 503 },
    );
    expect(await dispatcher.runOnce()).toMatchObject({ dead: 1, retried: 0 });
    expect(recorded[0].outcome).toMatchObject({
      status: 'dead',
      nextAttemptAt: null,
      attemptCount: 15,
      firstAttemptAt: first,
    });
  });

  it('fails a delivery whose secret cannot be opened, without sending anything', async () => {
    const { dispatcher, post, recorded } = setup([delivery()], undefined, new Error('boom'));
    await dispatcher.runOnce();
    expect(post).not.toHaveBeenCalled();
    expect(recorded[0].outcome).toMatchObject({
      status: 'failed',
      lastError: 'secret_unavailable',
    });
  });

  it('classifies a transport that throws, and keeps going when one record fails', async () => {
    const { dispatcher, store, recorded } = setup(
      [delivery({ id: 'a' }), delivery({ id: 'b' })],
      () => Promise.reject(new Error('x')),
    );
    vi.mocked(store.record).mockImplementationOnce(() => Promise.reject(new Error('db down')));
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 2, retried: 1, unrecorded: 1 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].outcome.lastError).toBe('network_error');
  });
});
