import { describe, expect, it } from 'vitest';
import type { NominationReceiver } from '../domain/nominate-rules.js';
import { DocumentNotFoundError, EventKeyReusedError } from './cancel-document.js';
import {
  NominationAlreadyRequestedError,
  NominationReasonInvalidError,
  NominationRefusedError,
  createNominateDocument,
} from './nominate-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import type {
  NewNomination,
  NominationTarget,
  NominationUnit,
} from './ports/nomination-unit-of-work.port.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const DOC = '22222222-2222-2222-2222-222222222222';
const RECEIVER: NominationReceiver = {
  kind: 'non-taxpayer',
  documentType: 1,
  documentNumber: '1234567',
  name: 'Juan Perez',
  country: 'PRY',
  operationType: 'B2C',
};

function setup(
  overrides: {
    target?: Partial<NominationTarget> | null;
    open?: { eventId: string } | null;
    stored?: { eventId: string; documentId: string | null; requestHash: string } | null;
    collideOnce?: boolean;
  } = {},
) {
  const inserted: NewNomination[] = [];
  const audits: unknown[] = [];
  let collide = overrides.collideOnce ?? false;
  let stored = collide ? null : (overrides.stored ?? null);
  const target: NominationTarget | null =
    overrides.target === null
      ? null
      : {
          id: DOC,
          cdc: 'c'.repeat(44),
          environment: 'test',
          documentType: 1,
          status: 'approved',
          receiverKind: 'unnamed',
          ...overrides.target,
        };
  const unit: NominationUnit = {
    findByIdempotencyKey: () => Promise.resolve(stored),
    lockDocument: () => Promise.resolve(target),
    findOpenNomination: () => Promise.resolve(overrides.open ?? null),
    insertNomination(event) {
      if (collide) {
        collide = false;
        stored = overrides.stored ?? null;
        return Promise.reject(new EventKeyCollisionError());
      }
      inserted.push(event);
      return Promise.resolve({ id: 'event-uuid' });
    },
    recordAudit(entry) {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const nominate = createNominateDocument({ unitOfWork: { run: (_t, work) => work(unit) } });
  return { nominate, inserted, audits };
}

const input = (overrides = {}) => ({
  tenantId: TENANT,
  actor: { type: 'api_key', id: 'key-1' } as const,
  documentId: DOC,
  reason: 'El receptor pidio nombrar la factura',
  receiver: RECEIVER,
  idempotencyKey: 'key-1',
  ...overrides,
});

describe('nominateDocument', () => {
  it('stores a pending nomination with the receiver and audits it', async () => {
    const { nominate, inserted, audits } = setup();
    expect(await nominate(input())).toEqual({
      eventId: 'event-uuid',
      documentId: DOC,
      status: 'pending',
    });
    expect(inserted[0]).toMatchObject({
      environment: 'test',
      documentId: DOC,
      reason: 'El receptor pidio nombrar la factura',
      receiver: RECEIVER,
      idempotencyKey: 'key-1',
    });
    expect(inserted[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'document.nomination_requested',
        entity: { type: 'document', id: DOC },
      }),
    ]);
  });

  it('refuses a reason that is too short, before touching the database', async () => {
    const { nominate, inserted } = setup();
    await expect(nominate(input({ reason: 'no' }))).rejects.toBeInstanceOf(
      NominationReasonInvalidError,
    );
    expect(inserted).toEqual([]);
  });

  it('fails when the document does not exist for the tenant', async () => {
    await expect(setup({ target: null }).nominate(input())).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });

  it.each([
    [{ documentType: 4 }, 'nominate-requires-fe'],
    [{ status: 'rejected' }, 'document-not-approved'],
    [{ receiverKind: 'named' as const }, 'nominate-receiver-named'],
  ])('refuses %j and stores nothing', async (target, rule) => {
    const { nominate, inserted } = setup({ target });
    const error = await nominate(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NominationRefusedError);
    expect((error as NominationRefusedError).refusal.rule).toBe(rule);
    expect(inserted).toEqual([]);
  });

  it('refuses a second nomination of the same CDC (4453)', async () => {
    const { nominate } = setup({ open: { eventId: 'ev-0' } });
    await expect(nominate(input())).rejects.toBeInstanceOf(NominationAlreadyRequestedError);
  });

  it('replays the response of the same key and body, without storing again', async () => {
    const first = setup();
    await first.nominate(input());
    const hash = first.inserted[0]?.requestHash ?? '';
    const { nominate, inserted } = setup({
      stored: { eventId: 'ev-9', documentId: DOC, requestHash: hash },
    });
    expect(await nominate(input())).toEqual({
      eventId: 'ev-9',
      documentId: DOC,
      status: 'pending',
    });
    expect(inserted).toEqual([]);
  });

  it('refuses a key reused with another body', async () => {
    const { nominate } = setup({
      stored: { eventId: 'ev-9', documentId: DOC, requestHash: 'f'.repeat(64) },
    });
    await expect(nominate(input())).rejects.toBeInstanceOf(EventKeyReusedError);
  });

  it('re-reads the key after losing a race on it', async () => {
    const first = setup();
    await first.nominate(input());
    const hash = first.inserted[0]?.requestHash ?? '';
    const { nominate } = setup({
      collideOnce: true,
      stored: { eventId: 'ev-7', documentId: DOC, requestHash: hash },
    });
    expect(await nominate(input())).toMatchObject({ eventId: 'ev-7' });
  });
});
