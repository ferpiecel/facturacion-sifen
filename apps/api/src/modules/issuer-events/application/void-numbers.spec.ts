import { describe, expect, it } from 'vitest';
import type { VoidRange } from '../domain/void-rules.js';
import { EventKeyReusedError } from './cancel-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import type { NewVoiding, RangeScope, VoidingUnit } from './ports/voiding-unit-of-work.port.js';
import { VoidRefusedError, createVoidNumbers } from './void-numbers.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const FOUND: RangeScope = {
  found: true,
  environment: 'test',
  timbradoId: 't',
  establishmentId: 'e',
  expeditionPointId: 'p',
};

interface Setup {
  scope?: RangeScope;
  lastNumber?: number | null;
  documents?: number[];
  open?: VoidRange[];
  stored?: { eventId: string; documentId: string | null; requestHash: string } | null;
  collideOnce?: boolean;
}

function setup(overrides: Setup = {}) {
  const inserted: NewVoiding[] = [];
  const audits: unknown[] = [];
  let collide = overrides.collideOnce ?? false;
  let stored = collide ? null : (overrides.stored ?? null);
  const unit: VoidingUnit = {
    findByIdempotencyKey: () => Promise.resolve(stored),
    resolveScope: () => Promise.resolve(overrides.scope ?? FOUND),
    lockLastNumber: () =>
      Promise.resolve(overrides.lastNumber === undefined ? 100 : overrides.lastNumber),
    listDocumentNumbersInRange: () => Promise.resolve(overrides.documents ?? []),
    listOpenVoidRanges: () => Promise.resolve(overrides.open ?? []),
    insertVoiding(event) {
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
  const voidNumbers = createVoidNumbers({ unitOfWork: { run: (_t, work) => work(unit) } });
  return { voidNumbers, inserted, audits };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  timbrado: '12345678',
  establishment: '001',
  expeditionPoint: '002',
  type: 1,
  from: 10,
  to: 20,
  reason: 'Numeración saltada por error',
  ...overrides,
});
const input = (overrides: Record<string, unknown> = {}, key = 'k-1') => ({
  tenantId: TENANT,
  actor: { type: 'api_key', id: 'key-1' } as const,
  body: body(overrides),
  idempotencyKey: key,
});
const rulesOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VoidRefusedError);
  return (error as VoidRefusedError).errors.map((e) => e.rule);
};

/** Spec: HU-E8-03. MT v150 11.6.2 (4052 to 4068). */
describe('voidNumbers', () => {
  it('stores a pending voiding of an issued, unused range and audits it', async () => {
    const { voidNumbers, inserted, audits } = setup();
    expect(await voidNumbers(input())).toEqual({ eventId: 'event-uuid', status: 'pending' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      environment: 'test',
      range: {
        timbrado: '12345678',
        establishment: '001',
        point: '002',
        from: 10,
        to: 20,
        type: 1,
      },
      reason: 'Numeración saltada por error',
      idempotencyKey: 'k-1',
    });
    expect(inserted[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(audits).toEqual([expect.objectContaining({ action: 'numbering.voiding_requested' })]);
  });

  it.each([
    ['timbrado', 'unknown-timbrado'],
    ['establishment', 'unknown-establishment'],
    ['expedition-point', 'unknown-expedition-point'],
  ] as const)('refuses an unknown %s', async (unknown, rule) => {
    const { voidNumbers, inserted } = setup({ scope: { found: false, unknown } });
    expect(await rulesOf(voidNumbers(input()))).toEqual([rule]);
    expect(inserted).toHaveLength(0);
  });

  it('refuses numbers that were never issued', async () => {
    const beyond = setup({ lastNumber: 15 });
    expect(await rulesOf(beyond.voidNumbers(input()))).toEqual(['range-beyond-issued-numbers']);
    const never = setup({ lastNumber: null });
    expect(await rulesOf(never.voidNumbers(input()))).toEqual(['range-beyond-issued-numbers']);
  });

  it('refuses a range that holds a document, listing its numbers (4065)', async () => {
    const { voidNumbers, inserted } = setup({ documents: [12, 13] });
    const error = await voidNumbers(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoidRefusedError);
    expect((error as VoidRefusedError).errors[0]).toMatchObject({
      rule: 'range-has-documents',
      sifenCode: '4065',
      numbers: [12, 13],
    });
    expect(inserted).toHaveLength(0);
  });

  it('refuses a range that overlaps a voiding already requested (4066)', async () => {
    const open: VoidRange = {
      timbrado: '12345678',
      establishment: '001',
      point: '002',
      type: 1,
      from: 18,
      to: 25,
    };
    const { voidNumbers } = setup({ open: [open] });
    expect(await rulesOf(voidNumbers(input()))).toEqual(['range-overlaps-voided']);
    const apart = setup({ open: [{ ...open, from: 21, to: 25 }] });
    await expect(apart.voidNumbers(input())).resolves.toMatchObject({ status: 'pending' });
  });

  it('replays the stored result for the same key and body', async () => {
    const first = setup();
    await first.voidNumbers(input());
    const requestHash = first.inserted[0].requestHash;
    const { voidNumbers, inserted } = setup({
      stored: { eventId: 'prior', documentId: null, requestHash },
      documents: [12],
    });
    expect(await voidNumbers(input())).toEqual({ eventId: 'prior', status: 'pending' });
    expect(inserted).toHaveLength(0);
  });

  it('answers a reused key with another body', async () => {
    const { voidNumbers } = setup({
      stored: { eventId: 'prior', documentId: null, requestHash: 'z'.repeat(64) },
    });
    await expect(voidNumbers(input())).rejects.toBeInstanceOf(EventKeyReusedError);
  });

  it('re-reads the key after losing a race to a concurrent commit', async () => {
    const first = setup();
    await first.voidNumbers(input());
    const requestHash = first.inserted[0].requestHash;
    const { voidNumbers } = setup({
      collideOnce: true,
      stored: { eventId: 'winner', documentId: null, requestHash },
    });
    expect(await voidNumbers(input())).toMatchObject({ eventId: 'winner' });
  });
});
