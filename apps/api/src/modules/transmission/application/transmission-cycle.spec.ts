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
  recoverable?: string[];
  recover?: (id: string) => Promise<unknown>;
  listAccepted?: () => Promise<readonly string[]>;
  nextRequestId?: () => Promise<bigint>;
  held?: { documentId: string; reason: string }[];
  stalePending?: number;
  holdFails?: boolean;
  stalePendingAfterMs?: number;
  swept?: number;
  sweepFails?: boolean;
  staleSendingAfterMs?: number;
  batch?: TransmissionCycleDeps['batch'];
}

function setup(o: Setup = {}) {
  const log: string[] = [];
  const warnings: string[] = [];
  const limits: Record<string, number> = {};
  const signals: (AbortSignal | undefined)[] = [];
  const holds: [string, string][] = [];
  const deferred: string[] = [];
  const cutoffs: Date[] = [];
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
    recoverableLoteIds: (at, limit) => {
      limits.recover = limit;
      log.push(`recoverable@${at.toISOString()}`);
      return Promise.resolve(o.recoverable ?? []);
    },
    sweepStaleSending: (cutoff, limit) => {
      limits.sweep = limit;
      log.push(`sweep@${cutoff.toISOString()}`);
      return o.sweepFails ? Promise.reject(new Error('db down')) : Promise.resolve(o.swept ?? 0);
    },
    nextRequestId: () => o.nextRequestId?.() ?? Promise.resolve((dId += 1n)),
    holdDocument: (documentId, reason) => {
      if (o.holdFails) return Promise.reject(new Error('db down'));
      holds.push([documentId, reason]);
      return Promise.resolve();
    },
    heldDocuments: () => Promise.resolve(o.held ?? []),
    deferPendingLote: (loteId) => {
      deferred.push(loteId);
      return Promise.resolve();
    },
    pendingOlderThan: (cutoff) => {
      cutoffs.push(cutoff);
      return Promise.resolve(o.stalePending ?? 0);
    },
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
    recoverer: {
      execute: async ({ loteId, signal }) => {
        log.push(`recover:${loteId}`);
        signals.push(signal);
        return (await o.recover?.(loteId)) ?? { status: 'not-due' };
      },
    } as TransmissionCycleDeps['recoverer'],
    now: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
    batch: o.batch,
    stalePendingAfterMs: o.stalePendingAfterMs,
    staleSendingAfterMs: o.staleSendingAfterMs,
  });
  return { cycle, log, warnings, limits, holds, deferred, cutoffs, signals };
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
      `sweep@${new Date(NOW.getTime() - 30 * 60_000).toISOString()}`,
      'send:l1:1',
      `due@${NOW.toISOString()}`,
      'poll:l2:2',
      `recoverable@${NOW.toISOString()}`,
    ]);
  });

  it('recovers lotes after polling, so a lote just handed over waits for its own pacing', async () => {
    const { cycle, log } = setup({ due: ['l1'], recoverable: ['l2'] });
    await cycle.run();
    expect(log.filter((e) => e.startsWith('poll:') || e.startsWith('recover:'))).toEqual([
      'poll:l1:1',
      'recover:l2',
    ]);
  });

  it('reports each recovered lote and isolates a failing one', async () => {
    const { cycle, warnings } = setup({
      recoverable: ['l1', 'l2', 'l3'],
      recover: (id) =>
        id === 'l2'
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ status: id === 'l1' ? 'recovered' : 'incomplete' }),
    });
    const report = await cycle.run();
    expect(report.recovered).toEqual([
      { loteId: 'l1', status: 'recovered' },
      { loteId: 'l3', status: 'incomplete' },
    ]);
    expect(report.failures).toEqual([{ step: 'recover', id: 'l2', error: 'Error' }]);
    expect(warnings).toHaveLength(1);
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
      recovered: [],
      sweptSending: 0,
      failures: [],
      held: [],
      stalePending: 0,
    });
    expect(defaults.limits).toEqual({ sign: 50, send: 20, poll: 20, recover: 10, sweep: 100 });

    const custom = setup({ batch: { sign: 3, send: 2, poll: 1, recover: 4, sweep: 7 } });
    await custom.cycle.run();
    expect(custom.limits).toEqual({ sign: 3, send: 2, poll: 1, recover: 4, sweep: 7 });
  });

  it('parks a document that fails signing with a deterministic error, by error class', async () => {
    const names = [
      'SigningDataIncompleteError',
      'EstablishmentContactMissingError',
      'CscNotConfiguredError',
      'DocumentEnvironmentMismatchError',
      'CertificateNotFoundError',
      'CertificateValidityError',
      'SecretDecryptionError',
      'InvoiceXmlError',
    ];
    const { cycle, holds } = setup({
      accepted: names,
      sign: (id) => Promise.reject(Object.assign(new Error('secret detail'), { name: id })),
    });

    const report = await cycle.run();

    expect(holds).toEqual(names.map((name) => [name, `signing:${name}`]));
    expect(report.failures).toHaveLength(names.length);
    expect(JSON.stringify(holds)).not.toContain('secret');
  });

  it('keeps retrying a document that fails signing with a transient error', async () => {
    const { cycle, holds } = setup({
      accepted: ['d1'],
      sign: () => Promise.reject(Object.assign(new Error('x'), { name: 'ConnectionError' })),
    });

    await cycle.run();

    expect(holds).toEqual([]);
  });

  it('keeps retrying a document whose KMS is unavailable instead of parking it', async () => {
    const { cycle, holds } = setup({
      accepted: ['d1'],
      sign: () =>
        Promise.reject(Object.assign(new Error('x'), { name: 'KeyServiceUnavailableError' })),
    });

    const report = await cycle.run();

    expect(report.failures).toEqual([
      { step: 'sign', id: 'd1', error: 'KeyServiceUnavailableError' },
    ]);
    expect(holds).toEqual([]);
  });

  it('records a failed hold as a failure of the document and carries on', async () => {
    const { cycle, log } = setup({
      accepted: ['d1', 'd2'],
      holdFails: true,
      sign: () => Promise.reject(Object.assign(new Error('x'), { name: 'CscNotConfiguredError' })),
    });

    const report = await cycle.run();

    expect(log).toContain(`sign:${TENANT}:d2`);
    expect(report.failures.map((f) => f.error)).toEqual([
      'CscNotConfiguredError',
      'Error',
      'CscNotConfiguredError',
      'Error',
    ]);
  });

  it('defers a pending lote whose send failed, so it does not hold the head of the queue', async () => {
    const { cycle, deferred } = setup({
      pending: [
        { loteId: 'l1', lote: lote() },
        { loteId: 'l2', lote: lote() },
      ],
      send: (id) =>
        id === 'l1' ? Promise.reject(new Error('x')) : Promise.resolve({ status: 'sent' }),
    });

    await cycle.run();

    expect(deferred).toEqual(['l1']);
  });

  it('reports the documents held for an operator and the pending lotes that are stale', async () => {
    const held = [{ documentId: 'd9', reason: 'transmission:attempts-exhausted' }];
    const { cycle, cutoffs } = setup({ held, stalePending: 2 });

    const report = await cycle.run();

    expect(report).toMatchObject({ held, stalePending: 2 });
    expect(cutoffs).toEqual([new Date(NOW.getTime() - 15 * 60_000)]);

    const custom = setup({ stalePendingAfterMs: 60_000 });
    await custom.cycle.run();
    expect(custom.cutoffs).toEqual([new Date(NOW.getTime() - 60_000)]);
  });

  it('sweeps lotes stuck in sending before sending, reports them, and survives a failing sweep', async () => {
    const { cycle, log } = setup({ swept: 2, pending: [{ loteId: 'l1', lote: lote() }] });
    const report = await cycle.run();
    expect(report.sweptSending).toBe(2);
    expect(log.findIndex((e) => e.startsWith('sweep@'))).toBeLessThan(
      log.findIndex((e) => e.startsWith('send:')),
    );

    const custom = setup({ staleSendingAfterMs: 60_000 });
    await custom.cycle.run();
    expect(custom.log).toContain(`sweep@${new Date(NOW.getTime() - 60_000).toISOString()}`);

    const failing = setup({ sweepFails: true, pending: [{ loteId: 'l1', lote: lote() }] });
    const failed = await failing.cycle.run();
    expect(failed.sweptSending).toBe(0);
    expect(failed.failures).toEqual([{ step: 'send', error: 'Error' }]);
    expect(failing.log).toContain('send:l1:1');
  });

  it('hands the run signal to the recoverer so it can stop between CDC queries', async () => {
    const controller = new AbortController();
    const { cycle, signals } = setup({ recoverable: ['l1', 'l2'] });
    await cycle.run({ signal: controller.signal });
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it('stops between units of work once its signal aborts (lost run lock) and says so', async () => {
    const controller = new AbortController();
    const { cycle, log } = setup({
      accepted: ['d1', 'd2'],
      pending: [{ loteId: 'l1', lote: lote() }],
      due: ['l2'],
      sign: (id) => {
        controller.abort();
        return Promise.resolve({ status: 'signed', cdc: id, signedAt: NOW });
      },
    });

    const report = await cycle.run({ signal: controller.signal });

    expect(log).toEqual([`sign:${TENANT}:d1`]);
    expect(report).toMatchObject({ signed: 1, aborted: true });
  });

  it('does not run at all with a signal that is already aborted, and omits the flag otherwise', async () => {
    const aborted = setup({ accepted: ['d1'] });
    expect(await aborted.cycle.run({ signal: AbortSignal.abort() })).toMatchObject({
      signed: 0,
      aborted: true,
    });
    expect(aborted.log).toEqual([]);

    expect(await setup().cycle.run()).not.toHaveProperty('aborted');
  });
});
