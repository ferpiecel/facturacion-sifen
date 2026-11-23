import { describe, expect, it } from 'vitest';
import { computeCdcCheckDigit } from '../../emission/domain/cdc.js';
import { createReceivedDocument } from '../domain/received-document.js';
import { EkuatiaSolveQuota } from './ekuatia-solve-quota.js';
import { IngestFromCdc } from './ingest-from-cdc.js';
import {
  FakeEkuatiaLookupQueue,
  InMemoryReceptionRepository,
  InMemorySolveUsageStore,
} from './testing/in-memory-reception.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
/** A structurally valid CDC (the SET example, check digit 8). */
const CDC = '01444444017001001001452822017012515873260988';
const BODY = CDC.slice(0, 43);
const BAD_CDC = `${BODY}${String((computeCdcCheckDigit(BODY) + 1) % 10)}`;
/** Same structure, another security code: a second, distinct valid CDC. */
const OTHER_BODY = `${BODY.slice(0, 42)}3`;
const OTHER_CDC = `${OTHER_BODY}${String(computeCdcCheckDigit(OTHER_BODY))}`;
const AT = new Date('2026-11-16T10:00:00.000Z');

function harness(over: { enabled?: boolean; tenantCap?: number; globalCap?: number } = {}) {
  const repository = new InMemoryReceptionRepository();
  const store = new InMemorySolveUsageStore();
  const queue = new FakeEkuatiaLookupQueue();
  const quota = new EkuatiaSolveQuota({
    store,
    tenantCap: over.tenantCap ?? 5,
    globalCap: over.globalCap ?? 50,
    now: () => AT,
    log: () => undefined,
  });
  const calls: string[] = [];
  const spyQuota = {
    reserve: (tenantId: string) => {
      calls.push('reserve');
      return quota.reserve(tenantId);
    },
  };
  const useCase = new IngestFromCdc({
    enabled: over.enabled ?? true,
    repository,
    quota: spyQuota,
    queue,
  });
  return { useCase, repository, store, queue, calls };
}

async function seedExisting(h: ReturnType<typeof harness>) {
  const document = createReceivedDocument({
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT,
    source: 'sifen_xml',
    isOwnReceiver: true,
  });
  await h.repository.create(TENANT, { document, header: { cdc: CDC } });
  return document;
}

/** Spec: reception R6.3 (request side). */
describe('IngestFromCdc', () => {
  it('queues a lookup for a bare CDC and answers accepted', async () => {
    const h = harness();
    const result = await h.useCase.execute({ tenantId: TENANT, reference: CDC });
    expect(result).toEqual({ kind: 'accepted', cdc: CDC, alreadyQueued: false });
    expect(h.queue.jobs).toEqual([{ tenantId: TENANT, cdc: CDC, usageDate: '2026-11-16' }]);
    expect(h.store.tenantUsed(TENANT, '2026-11-16')).toBe(1);
  });

  it('accepts the QR URL of a KuDE and extracts the CDC from Id=', async () => {
    const h = harness();
    const url = `https://ekuatia.set.gov.py/consultas/qr?nVersion=150&Id=${CDC}&dFeEmiDE=313230&cHashQR=abc`;
    const result = await h.useCase.execute({ tenantId: TENANT, reference: url });
    expect(result).toMatchObject({ kind: 'accepted', cdc: CDC });
  });

  it('answers disabled without touching the quota, the repository or the queue', async () => {
    const h = harness({ enabled: false });
    const result = await h.useCase.execute({ tenantId: TENANT, reference: CDC });
    expect(result).toEqual({ kind: 'disabled' });
    expect(h.calls).toEqual([]);
    expect(h.queue.jobs).toEqual([]);
  });

  it('rejects a bad check digit BEFORE reserving any solve', async () => {
    const h = harness();
    const result = await h.useCase.execute({ tenantId: TENANT, reference: BAD_CDC });
    expect(result).toEqual({ kind: 'invalid_reference', code: 'check-digit-mismatch' });
    expect(h.calls).toEqual([]);
    expect(h.queue.jobs).toEqual([]);
  });

  it.each([['hello'], [''], ['1234'], [`https://x.test/?Id=${'9'.repeat(43)}`]])(
    'rejects %j as not a CDC reference',
    async (reference) => {
      const h = harness();
      const result = await h.useCase.execute({ tenantId: TENANT, reference });
      expect(result).toMatchObject({ kind: 'invalid_reference' });
      expect(h.calls).toEqual([]);
    },
  );

  it('rejects an oversized reference without scanning it', async () => {
    const h = harness();
    const result = await h.useCase.execute({
      tenantId: TENANT,
      reference: `${' '.repeat(5_000)}${CDC}`,
    });
    expect(result).toEqual({ kind: 'invalid_reference', code: 'not-found' });
  });

  it('dedupes BEFORE solving: an existing document is returned and no slot is taken', async () => {
    const h = harness();
    const document = await seedExisting(h);
    const result = await h.useCase.execute({ tenantId: TENANT, reference: CDC });
    expect(result).toEqual({ kind: 'exists', document });
    expect(h.calls).toEqual([]);
    expect(h.queue.jobs).toEqual([]);
    expect(h.store.tenantUsed(TENANT, '2026-11-16')).toBe(0);
  });

  it('refuses over the tenant cap and names the scope', async () => {
    const h = harness({ tenantCap: 1 });
    await h.useCase.execute({ tenantId: TENANT, reference: CDC });
    const result = await h.useCase.execute({ tenantId: TENANT, reference: OTHER_CDC });
    expect(result).toMatchObject({ kind: 'quota_exceeded', scope: 'tenant', cap: 1 });
    expect(h.queue.jobs).toHaveLength(1);
  });

  it('refuses over the global cap', async () => {
    const h = harness({ globalCap: 1 });
    await h.useCase.execute({ tenantId: '22222222-2222-4222-8222-222222222222', reference: CDC });
    const result = await h.useCase.execute({ tenantId: TENANT, reference: OTHER_CDC });
    expect(result).toMatchObject({ kind: 'quota_exceeded', scope: 'global', cap: 1 });
  });

  it('gives the slot back and answers queue_unavailable when the queue is down', async () => {
    const h = harness();
    h.queue.failWith = new Error('down');
    const result = await h.useCase.execute({ tenantId: TENANT, reference: CDC });
    expect(result).toEqual({ kind: 'queue_unavailable' });
    expect(h.store.tenantUsed(TENANT, '2026-11-16')).toBe(0);
    expect(h.store.globalUsed('2026-11-16')).toBe(0);
  });

  it('a repeated request while the job exists is accepted without a second slot', async () => {
    const h = harness();
    await h.useCase.execute({ tenantId: TENANT, reference: CDC });
    const again = await h.useCase.execute({ tenantId: TENANT, reference: CDC });
    expect(again).toEqual({ kind: 'accepted', cdc: CDC, alreadyQueued: true });
    expect(h.store.tenantUsed(TENANT, '2026-11-16')).toBe(1);
    expect(h.queue.jobs).toHaveLength(1);
  });
});
