import { describe, expect, it } from 'vitest';
import type { SendEventBatchResult } from './send-event-batch.js';
import type { ResolveUnknownEventsResult } from './resolve-unknown-events.js';
import type { SignPendingEventResult } from './sign-pending-event.js';
import {
  TransmissionCycle,
  type TransmissionCycleDeps,
  type TransmissionCycleStore,
} from './transmission-cycle.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const idle: TransmissionCycleStore = {
  acceptedDocumentIds: () => Promise.resolve([]),
  pendingLotes: () => Promise.resolve([]),
  dueLoteIds: () => Promise.resolve([]),
  recoverableLoteIds: () => Promise.resolve([]),
  sweepStaleSending: () => Promise.resolve(0),
  nextRequestId: () => Promise.resolve(1n),
  holdDocument: () => Promise.resolve(),
  heldDocuments: () => Promise.resolve([]),
  deferPendingLote: () => Promise.resolve(),
  rucBlockedUntil: () => Promise.resolve(null),
  pendingOlderThan: () => Promise.resolve(0),
};

interface EventSetup {
  pending?: string[];
  sign?: (id: string) => Promise<SignPendingEventResult | undefined>;
  send?: () => Promise<SendEventBatchResult>;
  resolve?: () => Promise<ResolveUnknownEventsResult>;
  batch?: TransmissionCycleDeps['batch'];
  withoutEvents?: boolean;
}

function setup(o: EventSetup = {}) {
  const log: string[] = [];
  const warnings: string[] = [];
  const holds: string[] = [];
  const limits: Record<string, number> = {};
  const cycle = new TransmissionCycle({
    tenantId: TENANT,
    store: idle,
    signer: { execute: () => Promise.reject(new Error('unused')) },
    assembler: { assemble: () => Promise.resolve({ lotes: [], skipped: [] } as never) },
    sender: { execute: () => Promise.reject(new Error('unused')) },
    poller: { execute: () => Promise.reject(new Error('unused')) },
    recoverer: { execute: () => Promise.reject(new Error('unused')) },
    ...(o.withoutEvents
      ? {}
      : {
          events: {
            pendingEventIds: (limit: number) => {
              limits.signEvent = limit;
              return Promise.resolve(o.pending ?? []);
            },
            holdEvent: (eventId: string, reason: string) => {
              holds.push(`${eventId}:${reason}`);
              return Promise.resolve();
            },
            signer: {
              execute: async ({ eventId }: { tenantId: string; eventId: string }) => {
                log.push(`sign:${eventId}`);
                return (await o.sign?.(eventId)) ?? ({ status: 'signed' } as const);
              },
            },
            sender: {
              execute: () => {
                log.push('send');
                return o.send?.() ?? Promise.resolve({ status: 'empty' } as const);
              },
            },
            resolver: {
              execute: () => {
                log.push('resolve');
                return (
                  o.resolve?.() ??
                  Promise.resolve({ swept: 0, approved: 0, rejected: 0, inconclusive: 0 })
                );
              },
            },
          },
        }),
    batch: o.batch,
    logger: { warn: (message) => warnings.push(message) },
  });
  return { cycle, log, warnings, limits, holds };
}

describe('TransmissionCycle issuer events', () => {
  it('signs the pending events, then sends a batch, then resolves the unknown ones', async () => {
    const { cycle, log } = setup({ pending: ['e1', 'e2'] });

    const report = await cycle.run();

    expect(log).toEqual(['sign:e1', 'sign:e2', 'send', 'resolve']);
    expect(report.events).toEqual({
      signed: 2,
      signSkipped: 0,
      send: { status: 'empty' },
      resolve: { swept: 0, approved: 0, rejected: 0, inconclusive: 0 },
    });
  });

  it('reports what the batch and the recovery did', async () => {
    const { cycle } = setup({
      send: () => Promise.resolve({ status: 'sent', approved: 2, rejected: 1, unknown: 0 }),
      resolve: () => Promise.resolve({ swept: 1, approved: 1, rejected: 0, inconclusive: 2 }),
    });

    const report = await cycle.run();

    expect(report.events?.send).toEqual({ status: 'sent', approved: 2, rejected: 1, unknown: 0 });
    expect(report.events?.resolve).toEqual({ swept: 1, approved: 1, rejected: 0, inconclusive: 2 });
  });

  it('counts an event someone else already signed as skipped', async () => {
    const { cycle } = setup({
      pending: ['e1'],
      sign: () => Promise.resolve({ status: 'skipped', eventStatus: 'signed' }),
    });

    const report = await cycle.run();

    expect(report.events).toMatchObject({ signed: 0, signSkipped: 1 });
  });

  it.each(['EventIdOutOfRangeError', 'EventDataIncompleteError', 'EventKindNotSignableError'])(
    'parks an event whose signing fails with %s, so it stops starving the batch',
    async (name) => {
      const { cycle, holds } = setup({
        pending: ['e1', 'e2'],
        sign: (id) => {
          if (id !== 'e1') return Promise.resolve(undefined);
          const error = new Error('detail');
          error.name = name;
          return Promise.reject(error);
        },
      });

      await cycle.run();

      expect(holds).toEqual([`e1:signing:${name}`]);
    },
  );

  it('does not park an event for a transient signing failure', async () => {
    const { cycle, holds } = setup({
      pending: ['e1'],
      sign: () => Promise.reject(new TypeError('network')),
    });

    await cycle.run();

    expect(holds).toEqual([]);
  });

  it('isolates a failing signature, a failing send and a failing recovery, by error class only', async () => {
    const { cycle, log, warnings } = setup({
      pending: ['e1', 'e2'],
      sign: (id) =>
        id === 'e1' ? Promise.reject(new TypeError('secret detail')) : Promise.resolve(undefined),
      send: () => Promise.reject(new RangeError('secret detail')),
      resolve: () => Promise.reject(new Error('secret detail')),
    });

    const report = await cycle.run();

    expect(log).toEqual(['sign:e1', 'sign:e2', 'send', 'resolve']);
    expect(report.failures).toEqual([
      { step: 'sign-event', id: 'e1', error: 'TypeError' },
      { step: 'send-event', error: 'RangeError' },
      { step: 'resolve-event', error: 'Error' },
    ]);
    expect(report.events).toMatchObject({ signed: 1 });
    expect(warnings.join('\n')).not.toContain('secret detail');
  });

  it('bounds the events it signs per run (default 20, then override)', async () => {
    const first = setup();
    await first.cycle.run();
    expect(first.limits.signEvent).toBe(20);

    const second = setup({ batch: { signEvent: 5 } });
    await second.cycle.run();
    expect(second.limits.signEvent).toBe(5);
  });

  it('leaves events out of the report when the cycle has none wired', async () => {
    const { cycle, log } = setup({ withoutEvents: true });

    const report = await cycle.run();

    expect(report.events).toBeUndefined();
    expect(log).toEqual([]);
  });

  it('does not start event work once its signal aborted', async () => {
    const { cycle, log } = setup({ pending: ['e1'] });
    const controller = new AbortController();
    controller.abort();

    await cycle.run({ signal: controller.signal });

    expect(log).toEqual([]);
  });
});
