import { describe, expect, it, vi } from 'vitest';
import { createListAttentionDocuments } from './list-attention-documents.js';
import type {
  PortalAttentionRow,
  PortalAttentionSource,
} from './ports/portal-attention-source.port.js';

const NOW = new Date('2026-03-31T15:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function row(id: string, overrides: Partial<PortalAttentionRow> = {}): PortalAttentionRow {
  return {
    id,
    cdc: id.padEnd(44, '0'),
    documentType: 1,
    number: '001-001-0000001',
    issuedAt: new Date('2026-03-20T12:00:00Z'),
    receiverName: 'Cliente',
    receiverRuc: null,
    totalAmount: '110000.00000000',
    currency: 'PYG',
    status: 'signed',
    signedAt: hoursAgo(10),
    transmissionHold: null,
    sifenMessages: null,
    ...overrides,
  };
}

function setup(rows: PortalAttentionRow[], total = rows.length) {
  const listNeedingAttention = vi
    .fn<PortalAttentionSource['listNeedingAttention']>()
    .mockResolvedValue({ rows, total });
  const run = createListAttentionDocuments({ source: { listNeedingAttention }, now: () => NOW });
  return { run, listNeedingAttention };
}

describe('createListAttentionDocuments (HU-E12-04)', () => {
  it('asks for the 72 h and 12 h cut-offs of the injected clock', async () => {
    const { run, listNeedingAttention } = setup([]);

    await run('tenant-1');

    expect(listNeedingAttention).toHaveBeenCalledWith('tenant-1', {
      overdueBefore: new Date('2026-03-28T15:00:00Z'),
      dueSoonBefore: new Date('2026-03-29T03:00:00Z'),
      limit: 100,
    });
  });

  it('classifies each document and exposes its deadline and remaining hours', async () => {
    const { run } = setup([
      row('overdue', { signedAt: hoursAgo(80) }),
      row('soon', { status: 'queued', signedAt: hoursAgo(66) }),
      row('fine', { signedAt: hoursAgo(10) }),
    ]);

    const { items } = await run('t');

    expect(items.map((i) => [i.id, i.reasons])).toEqual([
      ['overdue', ['overdue']],
      ['soon', ['due_soon']],
    ]);
    expect(items[1]).toMatchObject({
      deadline: '2026-03-31T21:00:00.000Z',
      hoursRemaining: 6,
    });
  });

  it('leaves out a pending document with more than 12 h left', async () => {
    const { run } = setup([row('ok', { signedAt: hoursAgo(59) })]);

    expect((await run('t')).items).toEqual([]);
  });

  it('does not treat the exact 72 h mark as overdue', async () => {
    const { run } = setup([row('edge', { signedAt: hoursAgo(72) })]);

    const [item] = (await run('t')).items;

    expect(item.reasons).toEqual(['due_soon']);
    expect(item.hoursRemaining).toBe(0);
  });

  it('flags rejected documents with the reason SIFEN gave', async () => {
    const { run } = setup([
      row('rej', {
        status: 'rejected',
        signedAt: hoursAgo(5),
        sifenMessages: [{ code: '1321', message: 'RUC inexistente' }],
      }),
    ]);

    const [item] = (await run('t')).items;

    expect(item.reasons).toEqual(['rejected']);
    expect(item.rejectionReason).toBe('RUC inexistente');
  });

  it('flags held documents with the hold code, and lists every reason', async () => {
    const { run } = setup([
      row('held', {
        transmissionHold: 'signing:SigningDataIncompleteError',
        signedAt: hoursAgo(90),
      }),
    ]);

    const [item] = (await run('t')).items;

    expect(item.reasons).toEqual(['overdue', 'held']);
    expect(item.hold).toBe('signing:SigningDataIncompleteError');
  });

  it('a held document without signature has no deadline', async () => {
    const { run } = setup([
      row('held', { status: 'accepted', signedAt: null, transmissionHold: 'signing:X' }),
    ]);

    const [item] = (await run('t')).items;

    expect(item).toMatchObject({ reasons: ['held'], deadline: null, hoursRemaining: null });
  });

  it('orders by urgency, then by nearest deadline, then newest first', async () => {
    const { run } = setup([
      row('soon', { signedAt: hoursAgo(65) }),
      row('rej-new', { status: 'rejected', signedAt: hoursAgo(2) }),
      row('rej-old', { status: 'rejected', signedAt: hoursAgo(20) }),
      row('held', { status: 'accepted', signedAt: null, transmissionHold: 'x' }),
      row('over-late', { signedAt: hoursAgo(73) }),
      row('over-early', { signedAt: hoursAgo(100) }),
    ]);

    const { items } = await run('t');

    expect(items.map((i) => i.id)).toEqual([
      'over-early',
      'over-late',
      'held',
      'rej-old',
      'rej-new',
      'soon',
    ]);
  });

  it('reports the real total and whether the list was cut', async () => {
    const { run } = setup([row('a', { signedAt: hoursAgo(90) })], 140);

    expect(await run('t')).toMatchObject({ total: 140, truncated: true });
  });
});
