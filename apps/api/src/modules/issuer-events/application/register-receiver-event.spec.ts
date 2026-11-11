import { describe, expect, it } from 'vitest';
import { buildCdc } from '../../emission/domain/cdc.js';
import type { PriorReceiverEvent } from '../domain/receiver-event-rules.js';
import {
  ReceiverEventInvalidError,
  ReceiverEventRefusedError,
  ReceiverProfileMissingError,
  createRegisterReceiverEvent,
} from './register-receiver-event.js';
import { EventKeyReusedError } from './cancel-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import {
  ReceiverEventDuplicateError,
  type NewReceiverEvent,
  type ReceiverEventUnit,
  type StoredReceiverEvent,
} from './ports/receiver-event-unit-of-work.port.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const TENANT = '11111111-1111-1111-1111-111111111111';
const CDC = buildCdc({
  documentType: '01',
  rucBase: '80069563',
  rucDv: 1,
  establishment: '001',
  point: '001',
  documentNumber: '0000001',
  taxpayerType: 1,
  issueDate: '2026-10-01',
  emissionType: 1,
  securityCode: '123456789',
});
const body = (extra: Record<string, unknown> = {}) => ({
  kind: 'conformity',
  conformityType: 'total',
  cdc: CDC,
  issuedAt: '2026-10-01T10:00:00',
  ...extra,
});

function setup(
  overrides: {
    history?: PriorReceiverEvent[];
    stored?: StoredReceiverEvent | null;
    party?: { ruc: string; name: string } | null;
    collideOnce?: boolean;
    duplicate?: boolean;
  } = {},
) {
  const inserted: NewReceiverEvent[] = [];
  const audits: unknown[] = [];
  const locked: string[] = [];
  let collide = overrides.collideOnce ?? false;
  let stored = collide ? null : (overrides.stored ?? null);
  const unit: ReceiverEventUnit = {
    findByIdempotencyKey: () => Promise.resolve(stored),
    lockCdc(cdc) {
      locked.push(cdc);
      return Promise.resolve();
    },
    receiverIdentity: () =>
      Promise.resolve({
        environment: 'test',
        party:
          overrides.party === undefined
            ? { ruc: '80069563-1', name: 'Empresa SA' }
            : overrides.party,
      }),
    listEvents: () => Promise.resolve(overrides.history ?? []),
    insertEvent(event) {
      if (collide) {
        collide = false;
        stored = overrides.stored ?? null;
        return Promise.reject(new EventKeyCollisionError());
      }
      if (overrides.duplicate) return Promise.reject(new ReceiverEventDuplicateError());
      inserted.push(event);
      return Promise.resolve({ id: 'event-uuid' });
    },
    recordAudit(entry) {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const register = createRegisterReceiverEvent({
    unitOfWork: { run: (_tenant, work) => work(unit) },
    now: () => NOW,
  });
  const call = (input: unknown = body(), idempotencyKey = 'key-1') =>
    register({
      tenantId: TENANT,
      actor: { type: 'api_key', id: 'k' },
      body: input,
      idempotencyKey,
    });
  return { call, inserted, audits, locked };
}

/** Spec: HU-E9-01. The receiver registers an event over a CDC; the worker signs and sends it. */
describe('createRegisterReceiverEvent', () => {
  it('stores a pending conformity and audits it, locking the CDC first', async () => {
    const { call, inserted, audits, locked } = setup();

    await expect(call()).resolves.toEqual({
      eventId: 'event-uuid',
      kind: 'conformity',
      cdc: CDC,
      status: 'pending',
    });

    expect(locked).toEqual([CDC]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      environment: 'test',
      kind: 'conformity',
      cdc: CDC,
      reason: null,
      idempotencyKey: 'key-1',
      data: { issuedAt: '2026-10-01T10:00:00', conformityType: 'total' },
    });
    expect(inserted[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'receiver_event.registered',
        entity: { type: 'receiver_event', id: 'event-uuid' },
        after: { kind: 'conformity', cdc: CDC, status: 'pending' },
      }),
    ]);
  });

  it('stores the approval instant of a DTE as ISO text', async () => {
    const { call, inserted } = setup();

    await call(body({ approvedAt: '2026-10-01T11:00:00' }));

    expect(inserted[0]?.data.approvedAt).toBe('2026-10-01T14:00:00.000Z');
  });

  it('refuses an invalid body with its issues and stores nothing', async () => {
    const { call, inserted } = setup();

    const error = await call(body({ cdc: '123' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReceiverEventInvalidError);
    expect((error as ReceiverEventInvalidError).issues).toContainEqual({
      field: 'cdc',
      rule: 'cdc-invalid',
    });
    expect(inserted).toEqual([]);
  });

  it('refuses what the manual forbids, with the rule', async () => {
    const { call, inserted } = setup({
      history: [
        {
          kind: 'conformity',
          conformityType: 'total',
          registeredAt: new Date('2026-10-10T00:00:00Z'),
        },
      ],
    });

    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReceiverEventRefusedError);
    expect((error as ReceiverEventRefusedError).refusal).toMatchObject({
      rule: 'receiver-event-already-registered',
      sifenCode: '4150',
    });
    expect(inserted).toEqual([]);
  });

  it('refuses an unawareness or a notice when the tenant has no fiscal profile', async () => {
    const { call } = setup({ party: null });

    await expect(
      call(
        body({
          kind: 'receipt_notice',
          receivedAt: '2026-10-02T09:00:00',
          totalPyg: 1,
          conformityType: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(ReceiverProfileMissingError);
  });

  it('answers a retry with the same key and body with the first response, storing nothing again', async () => {
    const first = setup();
    await first.call();
    const hash = first.inserted[0]?.requestHash ?? '';
    const { call, inserted } = setup({
      stored: { eventId: 'event-uuid', kind: 'conformity', cdc: CDC, requestHash: hash },
    });

    await expect(call()).resolves.toMatchObject({ eventId: 'event-uuid', status: 'pending' });
    expect(inserted).toEqual([]);
  });

  it('refuses a key reused with another request', async () => {
    const { call } = setup({
      stored: { eventId: 'e', kind: 'conformity', cdc: CDC, requestHash: 'x'.repeat(64) },
    });

    await expect(call()).rejects.toBeInstanceOf(EventKeyReusedError);
  });

  it('re-reads the key when a concurrent request committed it first', async () => {
    const first = setup();
    await first.call();
    const hash = first.inserted[0]?.requestHash ?? '';
    const { call } = setup({
      collideOnce: true,
      stored: { eventId: 'winner', kind: 'conformity', cdc: CDC, requestHash: hash },
    });

    await expect(call()).resolves.toMatchObject({ eventId: 'winner' });
  });

  it('reports a concurrent duplicate of the same event as already registered', async () => {
    const { call } = setup({ duplicate: true });

    await expect(call()).rejects.toMatchObject({
      refusal: { rule: 'receiver-event-already-registered' },
    });
  });
});
