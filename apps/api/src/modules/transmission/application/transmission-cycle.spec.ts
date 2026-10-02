import { describe, expect, it } from 'vitest';
import type { Lote } from '../domain/lote-builder.js';
import type { AssembleLotesResult } from './assemble-lotes.js';
import {
  TransmissionCycle,
  type PendingLote,
  type TransmissionCycleDeps,
  type TransmissionCycleStore,
} from './transmission-cycle.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-02T12:00:00Z');

const lote = (documentType = '01'): Lote => ({
  rucBase: '80000001',
  rucDv: 3,
  documentType,
  documents: [{ cdc: 'cdc', xml: '<DE/>' }],
});

interface Setup {
  accepted?: string[];
  pending?: PendingLote[];
  due?: string[];
  sign?: (id: string) => Promise<unknown>;
  assemble?: () => Promise<AssembleLotesResult>;
  send?: (id: string) => Promise<unknown>;
  poll?: (id: string) => Promise<unknown>;
  listAccepted?: () => Promise<readonly string[]>;
  nextRequestId?: () => Promise<bigint>;
  batch?: TransmissionCycleDeps['batch'];
}

function setup(o: Setup = {}) {
  const log: string[] = [];
  const warnings: string[] = [];
  const limits: Record<string, number> = {};
  let dId = 0n;
  const signed = (id: string) => ({ status: 'signed', cdc: id, signedAt: NOW });
  const store: TransmissionCycleStore = {
    acceptedDocumentIds: (limit) => {
      limits.sign = limit;
      return o.listAccepted?.() ?? Promise.resolve(o.accepted ?? []);
    },
    pendingLotes: (limit) => {
      limits.send = limit;
      return Promise.resolve(o.pending ?? []);
    },
    dueLoteIds: (at, limit) => {
      limits.poll = limit;
      log.push(`due@${at.toISOString()}`);
      return Promise.resolve(o.due ?? []);
    },
    nextRequestId: () => o.nextRequestId?.() ?? Promise.resolve((dId += 1n)),
  };
  // The services are faked at their `execute`/`assemble` seam, so results are loosely typed.
  const cycle = new TransmissionCycle({
    tenantId: TENANT,
    store,
    signer: {
      execute: async ({ tenantId, documentId }) => {
        log.push(`sign:${tenantId}:${documentId}`);
        return (await o.sign?.(documentId)) ?? signed(documentId);
      },
    } as TransmissionCycleDeps['signer'],
    assembler: {
      assemble: async () => {
        log.push('assemble');
        return (await o.assemble?.()) ?? { lotes: [], skipped: [], conflicted: [] };
      },
    },
    sender: {
      execute: async ({ loteId, dId: id }) => {
        log.push(`send:${loteId}:${String(id)}`);
        return (await o.send?.(loteId)) ?? { status: 'sent', dProtConsLote: 'p' };
      },
    } as TransmissionCycleDeps['sender'],
    poller: {
      execute: async ({ loteId, dId: id }) => {
        log.push(`poll:${loteId}:${String(id)}`);
        return (await o.poll?.(loteId)) ?? { status: 'not-due' };
      },
    } as TransmissionCycleDeps['poller'],
    now: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
    batch: o.batch,
  });
  return { cycle, log, warnings, limits };
}

/** Spec: HU-E6-02 (S5a). One tenant's transmission cycle: sign, assemble, send, poll. */
describe('TransmissionCycle', () => {
  it('runs the steps in order: sign, assemble, send, poll', async () => {
    const { cycle, log } = setup({
      accepted: ['d1'],
      pending: [{ loteId: 'l1', lote: lote() }],
      due: ['l2'],
    });

    await cycle.run();

    expect(log).toEqual([
      `sign:${TENANT}:d1`,
      'assemble',
      'send:l1:1',
      `due@${NOW.toISOString()}`,
      'poll:l2:2',
    ]);
  });

  it('reports what each step did', async () => {
    const { cycle } = setup({
      accepted: ['d1', 'd2'],
      pending: [{ loteId: 'l1', lote: lote() }],
      due: ['l2', 'l3'],
      sign: (id) =>
        Promise.resolve(
          id === 'd1'
            ? { status: 'signed', cdc: id, signedAt: NOW }
            : { status: 'skipped', documentStatus: 'signed' },
        ),
      assemble: () =>
        Promise.resolve({
          lotes: [{ loteId: 'l1', documentType: '01', cdcs: ['c'] }],
          skipped: [{ cdc: 'x', reason: 'cdc-in-process' }],
          conflicted: [],
        }),
      poll: (id) => Promise.resolve(id === 'l2' ? { status: 'pending' } : { status: 'processed' }),
    });

    const report = await cycle.run();

    expect(report).toMatchObject({
      signed: 1,
      signSkipped: 1,
      assembled: 1,
      sent: [{ loteId: 'l1', status: 'sent' }],
      polled: [
        { loteId: 'l2', status: 'pending' },
        { loteId: 'l3', status: 'processed' },
      ],
      failures: [],
    });
  });

  it('keeps going when one document fails to sign and reports only the error class', async () => {
    const { cycle, log, warnings } = setup({
      accepted: ['d1', 'd2'],
      sign: (id) => {
        if (id === 'd1') {
          return Promise.reject(
            Object.assign(new Error('p12 password hunter2 at /secrets/x.p12'), {
              name: 'InvoiceXmlError',
            }),
          );
        }
        return Promise.resolve({ status: 'signed', cdc: id, signedAt: NOW });
      },
    });

    const report = await cycle.run();

    expect(log).toContain(`sign:${TENANT}:d2`);
    expect(report.signed).toBe(1);
    expect(report.failures).toEqual([{ step: 'sign', id: 'd1', error: 'InvoiceXmlError' }]);
    expect(warnings.join('\n')).toContain('d1');
    expect(warnings.join('\n')).not.toContain('hunter2');
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('isolates a failing step: listing or assembling errors do not stop the next steps', async () => {
    const { cycle, log, warnings } = setup({
      listAccepted: () => Promise.reject(new Error('lost: postgres://u:pw@host/db')),
      assemble: () => Promise.reject(new Error('boom')),
      pending: [{ loteId: 'l1', lote: lote() }],
      due: ['l2'],
    });

    const report = await cycle.run();

    expect(log).toContain('send:l1:1');
    expect(log).toContain('poll:l2:2');
    expect(report.failures).toEqual([
      { step: 'sign', error: 'Error' },
      { step: 'assemble', error: 'Error' },
    ]);
    expect(warnings.join('\n')).not.toContain('postgres://');
  });

  it('sends every pending lote with its own dId, isolating a send or dId failure per lote', async () => {
    const { cycle, log } = setup({
      pending: ['l1', 'l2', 'l3', 'l4'].map((loteId) => ({ loteId, lote: lote() })),
      send: (id) =>
        id === 'l2'
          ? Promise.reject(new Error('record failed'))
          : Promise.resolve(id === 'l1' ? { status: 'sent' } : { status: 'already-claimed' }),
      nextRequestId: (() => {
        let calls = 0;
        return () =>
          (calls += 1) === 3
            ? Promise.reject(new Error('exhausted'))
            : Promise.resolve(BigInt(calls));
      })(),
    });

    const report = await cycle.run();

    expect(log.filter((entry) => entry.startsWith('send:'))).toEqual([
      'send:l1:1',
      'send:l2:2',
      'send:l4:4',
    ]);
    expect(report.sent.map((s) => s.status)).toEqual(['sent']);
    expect(report.sendSkipped).toBe(1);
    expect(report.failures).toEqual([
      { step: 'send', id: 'l2', error: 'Error' },
      { step: 'send', id: 'l3', error: 'Error' },
    ]);
  });

  it('polls due lotes with the cycle clock and isolates a failing one', async () => {
    const { cycle, log, warnings } = setup({
      due: ['l1', 'l2'],
      poll: (id) =>
        id === 'l1' ? Promise.reject(new Error('x')) : Promise.resolve({ status: 'stale' }),
    });

    const report = await cycle.run();

    expect(log).toContain(`due@${NOW.toISOString()}`);
    expect(report.polled).toEqual([{ loteId: 'l2', status: 'stale' }]);
    expect(report.failures).toEqual([{ step: 'poll', id: 'l1', error: 'Error' }]);
    expect(warnings).toHaveLength(1);
  });

  it('bounds every step with its batch size (defaults, then overrides)', async () => {
    const defaults = setup();
    expect(await defaults.cycle.run()).toEqual({
      signed: 0,
      signSkipped: 0,
      assembled: 0,
      sendSkipped: 0,
      sent: [],
      polled: [],
      failures: [],
    });
    expect(defaults.limits).toEqual({ sign: 50, send: 20, poll: 20 });

    const custom = setup({ batch: { sign: 3, send: 2, poll: 1 } });
    await custom.cycle.run();
    expect(custom.limits).toEqual({ sign: 3, send: 2, poll: 1 });
  });
});
