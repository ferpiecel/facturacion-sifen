import { describe, expect, it } from 'vitest';
import type { DocumentResponse } from './get-document.js';
import { createWaitForDocument } from './wait-for-document.js';

/** Spec: HU-E6-06, `?wait=true` holds the response for a flagged tenant until the document is final. */
const doc = (status: string): DocumentResponse => ({
  document_id: 'd1',
  cdc: '0'.repeat(44),
  number: '001-002-0000001',
  status,
  environment: 'test',
  issued_at: '2026-10-27T00:00:00.000Z',
  totals: { amount: '1', currency: 'PYG' },
  receiver: null,
  sifen: null,
  urls: { xml: null, kude: null },
});

function setup(statuses: string[], enabled = true) {
  let clock = 0;
  const reads: string[] = [];
  const wait = createWaitForDocument({
    isSyncEnabled: () => Promise.resolve(enabled),
    getDocument: () => {
      reads.push('read');
      return Promise.resolve(doc(statuses[Math.min(reads.length - 1, statuses.length - 1)]));
    },
    timeoutMs: 2_000,
    pollMs: 500,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  return { wait, reads, elapsed: () => clock };
}

describe('createWaitForDocument', () => {
  it('returns null at once for a tenant without the flag', async () => {
    const { wait, reads } = setup(['approved'], false);
    expect(await wait('t', 'd1')).toBeNull();
    expect(reads).toHaveLength(0);
  });

  it('polls every 500 ms until the document is final', async () => {
    const { wait, reads, elapsed } = setup(['accepted', 'submitted', 'approved']);
    expect((await wait('t', 'd1'))?.status).toBe('approved');
    expect(reads).toHaveLength(3);
    expect(elapsed()).toBe(1_000);
  });

  it.each(['approved_with_observations', 'rejected'])('treats %s as final', async (status) => {
    const { wait } = setup([status]);
    expect((await wait('t', 'd1'))?.status).toBe(status);
  });

  it('gives up at the timeout and returns null', async () => {
    const { wait, elapsed } = setup(['submitted']);
    expect(await wait('t', 'd1')).toBeNull();
    expect(elapsed()).toBe(2_000);
  });
});
