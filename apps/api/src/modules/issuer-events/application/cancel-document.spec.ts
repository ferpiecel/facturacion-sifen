import { describe, expect, it } from 'vitest';
import { DEFAULT_CANCEL_WINDOW } from '../domain/cancel-rules.js';
import {
  CancellationAlreadyRequestedError,
  CancellationRefusedError,
  CancelReasonInvalidError,
  DocumentNotFoundError,
  EventKeyReusedError,
  createCancelDocument,
} from './cancel-document.js';
import {
  EventKeyCollisionError,
  type CancellationTarget,
  type CancellationUnit,
  type NewCancellation,
  type StoredEvent,
} from './ports/cancellation-unit-of-work.port.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const TENANT = '11111111-1111-1111-1111-111111111111';
const DOC = '22222222-2222-2222-2222-222222222222';

function setup(
  overrides: {
    target?: Partial<CancellationTarget> | null;
    live?: string[];
    open?: { eventId: string } | null;
    stored?: StoredEvent | null;
    collideOnce?: boolean;
  } = {},
) {
  const inserted: NewCancellation[] = [];
  const audits: unknown[] = [];
  let collide = overrides.collideOnce ?? false;
  let stored = collide ? null : (overrides.stored ?? null);
  const target: CancellationTarget | null =
    overrides.target === null
      ? null
      : {
          id: DOC,
          cdc: 'c'.repeat(44),
          environment: 'test',
          documentType: 1,
          status: 'approved',
          approvedAt: new Date('2026-10-10T12:00:00Z'),
          signedAt: null,
          ...overrides.target,
        };
  const unit: CancellationUnit = {
    findByIdempotencyKey() {
      return Promise.resolve(stored);
    },
    lockDocument() {
      return Promise.resolve(target);
    },
    listLiveAssociatedCdcs() {
      return Promise.resolve(overrides.live ?? []);
    },
    findOpenCancellation() {
      return Promise.resolve(overrides.open ?? null);
    },
    insertCancellation(event) {
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
  const cancel = createCancelDocument({
    unitOfWork: { run: (_tenant, work) => work(unit) },
    now: () => NOW,
    window: DEFAULT_CANCEL_WINDOW,
  });
  return { cancel, inserted, audits };
}

const input = (overrides = {}) => ({
  tenantId: TENANT,
  actor: { type: 'api_key', id: 'key-1' } as const,
  documentId: DOC,
  reason: 'Error en el importe facturado',
  idempotencyKey: 'key-1',
  ...overrides,
});

describe('cancelDocument', () => {
  it('stores a pending cancellation and audits it', async () => {
    const { cancel, inserted, audits } = setup();
    const result = await cancel(input());
    expect(result).toEqual({ eventId: 'event-uuid', documentId: DOC, status: 'pending' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      environment: 'test',
      documentId: DOC,
      reason: 'Error en el importe facturado',
      idempotencyKey: 'key-1',
    });
    expect(inserted[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'document.cancellation_requested',
        entity: { type: 'document', id: DOC },
      }),
    ]);
  });

  it('refuses an invalid reason before reading anything', async () => {
    const { cancel, inserted } = setup();
    await expect(cancel(input({ reason: 'no' }))).rejects.toBeInstanceOf(CancelReasonInvalidError);
    expect(inserted).toHaveLength(0);
  });

  it("answers 404 for a document that is not the tenant's", async () => {
    const { cancel } = setup({ target: null });
    await expect(cancel(input())).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it('refuses outside the window and burns nothing', async () => {
    const { cancel, inserted } = setup({
      target: { approvedAt: new Date('2026-10-01T00:00:00Z') },
    });
    await expect(cancel(input())).rejects.toMatchObject({
      name: 'CancellationRefusedError',
      refusal: { rule: 'cancel-window-expired', sifenCode: '4009' },
    });
    expect(inserted).toHaveLength(0);
  });

  it('refuses a document with a live associated credit note, listing it', async () => {
    const { cancel } = setup({ live: ['x'.repeat(44)] });
    const error = await cancel(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancellationRefusedError);
    expect((error as CancellationRefusedError).refusal).toMatchObject({
      rule: 'has-live-associated-documents',
      associatedCdcs: ['x'.repeat(44)],
    });
  });

  it('refuses a second cancellation while one is open (4003)', async () => {
    const { cancel, inserted } = setup({ open: { eventId: 'e1' } });
    await expect(cancel(input())).rejects.toBeInstanceOf(CancellationAlreadyRequestedError);
    expect(inserted).toHaveLength(0);
  });

  it('replays the stored result for the same key and body, without checking the window again', async () => {
    const first = setup();
    await first.cancel(input());
    const hash = first.inserted[0].requestHash;
    const { cancel, inserted } = setup({
      stored: { eventId: 'prior', documentId: DOC, requestHash: hash },
      target: { approvedAt: new Date('2026-10-01T00:00:00Z') },
    });
    expect(await cancel(input())).toEqual({ eventId: 'prior', documentId: DOC, status: 'pending' });
    expect(inserted).toHaveLength(0);
  });

  it('answers 409 when the key is reused with another body', async () => {
    const { cancel } = setup({
      stored: { eventId: 'prior', documentId: DOC, requestHash: 'z'.repeat(64) },
    });
    await expect(cancel(input())).rejects.toBeInstanceOf(EventKeyReusedError);
  });

  it('re-reads the key after losing a race to a concurrent commit', async () => {
    const first = setup();
    await first.cancel(input());
    const hash = first.inserted[0].requestHash;
    const { cancel } = setup({
      collideOnce: true,
      stored: { eventId: 'winner', documentId: DOC, requestHash: hash },
    });
    expect(await cancel(input())).toMatchObject({ eventId: 'winner' });
  });
});
