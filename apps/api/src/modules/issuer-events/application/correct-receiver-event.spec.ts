import { describe, expect, it } from 'vitest';
import { buildCdc } from '../../emission/domain/cdc.js';
import type { PriorReceiverEvent } from '../domain/receiver-event-rules.js';
import {
  ReceiverEventNotFoundError,
  ReceiverCorrectionRefusedError,
  createCorrectReceiverEvent,
} from './correct-receiver-event.js';
import {
  ReceiverEventInvalidError,
  ReceiverEventRefusedError,
  ReceiverProfileMissingError,
} from './register-receiver-event.js';
import { EventKeyReusedError } from './cancel-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import {
  ReceiverEventDuplicateError,
  type CorrectionTarget,
  type CorrectionUnit,
  type NewReceiverEvent,
  type StoredReceiverEvent,
} from './ports/receiver-event-unit-of-work.port.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const TENANT = '11111111-1111-1111-1111-111111111111';
const ORIGINAL = '22222222-2222-2222-2222-222222222222';
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
const OTHER_CDC = buildCdc({
  documentType: '01',
  rucBase: '80069563',
  rucDv: 1,
  establishment: '001',
  point: '001',
  documentNumber: '0000002',
  taxpayerType: 1,
  issueDate: '2026-10-01',
  emissionType: 1,
  securityCode: '123456789',
});
const target = (extra: Partial<CorrectionTarget> = {}): CorrectionTarget => ({
  cdc: CDC,
  kind: 'conformity',
  conformityType: 'total',
  status: 'approved',
  respondedAt: new Date('2026-10-18T12:00:00Z'),
  isCorrection: false,
  alreadyCorrected: false,
  isLatestConclusive: true,
  ...extra,
});
const body = (extra: Record<string, unknown> = {}) => ({
  kind: 'disconformity',
  cdc: CDC,
  issuedAt: '2026-10-01T10:00:00',
  reason: 'Mercadería dañada al recibirla',
  correctionReason: 'Se registró conformidad por error',
  ...extra,
});

function setup(
  overrides: {
    original?: CorrectionTarget | null;
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
  const original = overrides.original === undefined ? target() : overrides.original;
  const unit: CorrectionUnit = {
    findByIdempotencyKey: () => Promise.resolve(stored),
    cdcOfEvent: () => Promise.resolve(original?.cdc ?? null),
    findCorrectable: () => Promise.resolve(original),
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
    listEvents: () =>
      Promise.resolve(
        overrides.history ?? [
          {
            kind: 'conformity',
            conformityType: 'total',
            registeredAt: new Date('2026-10-17T12:00:00Z'),
          },
        ],
      ),
    insertEvent(event) {
      if (collide) {
        collide = false;
        stored = overrides.stored ?? null;
        return Promise.reject(new EventKeyCollisionError());
      }
      if (overrides.duplicate) return Promise.reject(new ReceiverEventDuplicateError());
      inserted.push(event);
      return Promise.resolve({ id: 'new-event-uuid' });
    },
    recordAudit(entry) {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const correct = createCorrectReceiverEvent({
    unitOfWork: { run: (_tenant, work) => work(unit) },
    now: () => NOW,
  });
  const call = (input: unknown = body(), idempotencyKey = 'key-1', eventId = ORIGINAL) =>
    correct({
      tenantId: TENANT,
      actor: { type: 'api_key', id: 'k' },
      eventId,
      body: input,
      idempotencyKey,
    });
  return { call, inserted, audits, locked };
}

/** Spec: HU-E9-02. The receiver replaces an approved event with the opposite one, once, within 15 days. */
describe('createCorrectReceiverEvent', () => {
  it('stores the replacement pending, linked to the original, and audits it after locking the CDC', async () => {
    const { call, inserted, audits, locked } = setup();

    await expect(call()).resolves.toEqual({
      eventId: 'new-event-uuid',
      correctsEventId: ORIGINAL,
      kind: 'disconformity',
      cdc: CDC,
      status: 'pending',
    });

    expect(locked).toEqual([CDC]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      kind: 'disconformity',
      cdc: CDC,
      reason: 'Mercadería dañada al recibirla',
      correction: { originalEventId: ORIGINAL, reason: 'Se registró conformidad por error' },
    });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'receiver_event.corrected',
        entity: { type: 'receiver_event', id: 'new-event-uuid' },
        after: { kind: 'disconformity', cdc: CDC, status: 'pending', corrects: ORIGINAL },
      }),
    ]);
  });

  it('refuses an invalid body or correction reason and stores nothing', async () => {
    const { call, inserted } = setup();

    await expect(call(body({ correctionReason: 'no' }))).rejects.toMatchObject({
      issues: [{ field: 'correctionReason', rule: 'correction-reason-invalid' }],
    });
    await expect(call(body({ kind: 'nope' }))).rejects.toBeInstanceOf(ReceiverEventInvalidError);
    expect(inserted).toHaveLength(0);
  });

  it('answers not found for an event the tenant does not have', async () => {
    const { call } = setup({ original: null });

    await expect(call()).rejects.toBeInstanceOf(ReceiverEventNotFoundError);
  });

  it('refuses a replacement for another CDC', async () => {
    const { call, inserted } = setup();

    await expect(call(body({ cdc: OTHER_CDC }))).rejects.toMatchObject({
      issues: [{ field: 'cdc', rule: 'cdc-differs-from-original' }],
    });
    expect(inserted).toHaveLength(0);
  });

  it('refuses what the correction rules refuse', async () => {
    const { call, inserted } = setup({ original: target({ isCorrection: true }) });

    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReceiverCorrectionRefusedError);
    expect((error as ReceiverCorrectionRefusedError).refusal.rule).toBe('correction-of-correction');
    expect(inserted).toHaveLength(0);
  });

  it('refuses a window expired for the original', async () => {
    const { call } = setup({ original: target({ respondedAt: new Date('2026-09-01T00:00:00Z') }) });

    await expect(call()).rejects.toMatchObject({
      refusal: { rule: 'correction-window-expired' },
    });
  });

  it('needs the fiscal profile when the replacement names the receiver', async () => {
    const { call } = setup({
      original: target({ kind: 'disconformity', conformityType: undefined }),
      history: [{ kind: 'disconformity', registeredAt: new Date('2026-10-17T12:00:00Z') }],
      party: null,
    });

    await expect(
      call(
        body({ kind: 'unawareness', receivedAt: '2026-10-02T10:00:00', reason: 'No lo conozco' }),
      ),
    ).rejects.toBeInstanceOf(ReceiverProfileMissingError);
  });

  it('maps the unique index of open events to an already-registered refusal', async () => {
    const { call } = setup({ duplicate: true });

    await expect(call()).rejects.toBeInstanceOf(ReceiverEventRefusedError);
  });

  it('replays the stored result for the same key and body', async () => {
    const first = setup();
    await first.call();
    const hash = first.inserted[0].requestHash;
    const { call, inserted } = setup({
      stored: { eventId: 'prev', kind: 'disconformity', cdc: CDC, requestHash: hash },
    });

    await expect(call()).resolves.toEqual({
      eventId: 'prev',
      correctsEventId: ORIGINAL,
      kind: 'disconformity',
      cdc: CDC,
      status: 'pending',
    });
    expect(inserted).toHaveLength(0);
  });

  it('refuses a reused key with another body', async () => {
    const { call } = setup({
      stored: { eventId: 'prev', kind: 'disconformity', cdc: CDC, requestHash: 'x'.repeat(64) },
    });

    await expect(call()).rejects.toBeInstanceOf(EventKeyReusedError);
  });

  it('retries once when a concurrent commit took the key', async () => {
    const first = setup();
    await first.call();
    const hash = first.inserted[0].requestHash;
    const { call } = setup({
      collideOnce: true,
      stored: { eventId: 'prev', kind: 'disconformity', cdc: CDC, requestHash: hash },
    });

    await expect(call()).resolves.toMatchObject({ eventId: 'prev' });
  });
});
