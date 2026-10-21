import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import type { EventOutcome } from './send-event-batch.js';
import {
  LOCAL_NOT_REGISTERED_CODE,
  ResolveUnknownEvents,
  type EventRecoveryStore,
  type UnresolvedCancellation,
} from './resolve-unknown-events.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const CDC = '01800695631001001000000112026010111234567891';
const OTHER_CDC = '01800695631001001000000212026010111234567892';
const cancellationOf = (cdc: string) =>
  `<xEvento><gGroupGesEve><rGesEve><rEve Id="5"><gGroupTiEvt><rGeVeCan><Id>${cdc}</Id><mOtEve>x</mOtEve></rGeVeCan></gGroupTiEvt></rEve></rGesEve></gGroupGesEve></xEvento>`;

class InMemoryStore implements EventRecoveryStore {
  readonly sweeps: { cutoff: Date; limit: number }[] = [];
  readonly asked: { sentBefore: Date; limit: number }[] = [];
  readonly notes = new Map<string, string>();
  readonly misses = new Map<string, string>();
  readonly holds = new Map<string, string>();
  /** Ids whose `record` throws, as a database failure would. */
  readonly failingRecord = new Set<string>();
  readonly failingNote = new Set<string>();
  readonly outcomes = new Map<string, EventOutcome>();
  constructor(
    private readonly unresolved: readonly UnresolvedCancellation[],
    private readonly swept = 0,
  ) {}
  sweepStaleSending(cutoff: Date, limit: number) {
    this.sweeps.push({ cutoff, limit });
    return Promise.resolve(this.swept);
  }
  unresolvedCancellations(sentBefore: Date, limit: number) {
    this.asked.push({ sentBefore, limit });
    return Promise.resolve(this.unresolved);
  }
  noteInconclusive(id: string, note: string) {
    if (this.failingNote.has(id)) return Promise.reject(new Error('db down'));
    this.notes.set(id, note);
    return Promise.resolve();
  }
  noteMissing(id: string, note: string) {
    this.misses.set(id, note);
    return Promise.resolve();
  }
  hold(id: string, note: string) {
    this.holds.set(id, note);
    return Promise.resolve();
  }
  record(outcomes: ReadonlyMap<string, EventOutcome>) {
    for (const [id, outcome] of outcomes) {
      if (this.failingRecord.has(id)) return Promise.reject(new Error('conflict'));
      this.outcomes.set(id, outcome);
    }
    return Promise.resolve();
  }
}

function setup(unresolved: readonly UnresolvedCancellation[], swept = 0) {
  const warnings: string[] = [];
  const gateway = new FakeSifenGateway();
  const store = new InMemoryStore(unresolved, swept);
  const resolve = new ResolveUnknownEvents({
    gateway,
    store,
    nextRequestId: () => Promise.resolve(90n),
    now: () => NOW,
    staleSendingAfterMs: 30 * 60_000,
    settleAfterMs: 15 * 60_000,
    confirmAfterMs: 15 * 60_000,
    holdAfterMs: 72 * 3_600_000,
    limit: 10,
    logger: { warn: (message: string) => warnings.push(message) },
  });
  return { gateway, store, resolve, warnings };
}

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const one: UnresolvedCancellation = {
  id: 'ev-1',
  cdc: CDC,
  sentAt: minutesAgo(60),
  missedAt: null,
};
const missedLongAgo: UnresolvedCancellation = { ...one, missedAt: minutesAgo(30) };

describe('ResolveUnknownEvents', () => {
  it('turns orphan sending events older than the threshold into unknown, and asks only for settled ones', async () => {
    const { store, resolve } = setup([], 3);

    const result = await resolve.execute();

    expect(store.sweeps).toEqual([{ cutoff: new Date('2026-10-17T11:30:00Z'), limit: 10 }]);
    expect(store.asked).toEqual([{ sentBefore: new Date('2026-10-17T11:45:00Z'), limit: 10 }]);
    expect(result).toMatchObject({ swept: 3 });
  });

  it('settles as approved a cancellation that SIFEN shows registered on the document', async () => {
    const { gateway, store, resolve } = setup([one]);
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', [cancellationOf(CDC)]));

    const result = await resolve.execute();

    expect(gateway.callsTo('consultarDE')).toEqual([[{ dId: 90n, cdc: CDC }]]);
    expect(store.outcomes.get('ev-1')).toMatchObject({ status: 'approved', code: '0600' });
    expect(result).toMatchObject({ approved: 1, rejected: 0, inconclusive: 0 });
  });

  it('settles as rejected, locally, only when an earlier pass already found the cancellation absent', async () => {
    const { gateway, store, resolve } = setup([missedLongAgo]);
    gateway.enqueue(
      'consultarDE',
      sifenScenarios.cdcEncontrado('<rDE/>', [cancellationOf(OTHER_CDC)]),
    );

    const result = await resolve.execute();

    expect(store.outcomes.get('ev-1')).toMatchObject({
      status: 'rejected',
      code: LOCAL_NOT_REGISTERED_CODE,
    });
    expect(result).toMatchObject({ approved: 0, rejected: 1 });
  });

  it('only notes the first absence: SIFEN may lag, so the rejection waits for a later pass', async () => {
    const { gateway, store, resolve } = setup([one]);
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', []));

    const result = await resolve.execute();

    expect(store.outcomes.size).toBe(0);
    expect(store.misses.has('ev-1')).toBe(true);
    expect(result).toMatchObject({ rejected: 0, inconclusive: 1 });
  });

  it('does not reject on a repeat absence that is too close to the first one', async () => {
    const { gateway, store, resolve } = setup([{ ...one, missedAt: minutesAgo(5) }]);
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', []));

    await resolve.execute();

    expect(store.outcomes.size).toBe(0);
    expect(store.misses.size).toBe(0);
    expect(store.notes.has('ev-1')).toBe(true);
  });

  it('approves a cancellation whose events carry namespace prefixes', async () => {
    const { gateway, store, resolve } = setup([one]);
    const prefixed = `<ns2:xEvento><ns2:rGeVeCan><ns2:Id>${CDC}</ns2:Id></ns2:rGeVeCan></ns2:xEvento>`;
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', [prefixed]));

    await resolve.execute();

    expect(store.outcomes.get('ev-1')).toMatchObject({ status: 'approved' });
  });

  it('isolates a failing event: the pass goes on, and only ids are logged', async () => {
    const second: UnresolvedCancellation = { ...one, id: 'ev-2', cdc: OTHER_CDC };
    const { gateway, store, resolve, warnings } = setup([one, second]);
    store.failingRecord.add('ev-1');
    store.failingNote.add('ev-1');
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', [cancellationOf(CDC)]));
    gateway.enqueue(
      'consultarDE',
      sifenScenarios.cdcEncontrado('<rDE/>', [cancellationOf(OTHER_CDC)]),
    );

    const result = await resolve.execute();

    expect(store.outcomes.get('ev-2')).toMatchObject({ status: 'approved' });
    expect(result).toMatchObject({ approved: 1, inconclusive: 1 });
    expect(warnings.join(' ')).toContain('ev-1');
    expect(warnings.join(' ')).not.toContain(CDC);
  });

  it('holds for an operator an event still unresolved after the 72 h window', async () => {
    const { gateway, store, resolve, warnings } = setup([
      { ...missedLongAgo, sentAt: new Date(NOW.getTime() - 73 * 3_600_000), missedAt: null },
    ]);
    gateway.enqueue('consultarDE', sifenScenarios.cdcInexistente());

    const result = await resolve.execute();

    expect(store.holds.has('ev-1')).toBe(true);
    expect(store.notes.size).toBe(0);
    expect(result).toMatchObject({ inconclusive: 1 });
    expect(warnings.join(' ')).toContain('ev-1');
  });

  it('still approves a late event found registered, past the window', async () => {
    const { gateway, store, resolve } = setup([
      { ...one, sentAt: new Date(NOW.getTime() - 100 * 3_600_000) },
    ]);
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', [cancellationOf(CDC)]));

    await resolve.execute();

    expect(store.outcomes.get('ev-1')).toMatchObject({ status: 'approved' });
    expect(store.holds.size).toBe(0);
  });

  it.each([
    ['the query fails', new SifenTimeoutError('consultarDE')],
    ['SIFEN does not know the document', sifenScenarios.cdcInexistente()],
  ])('leaves the event unknown and notes it when %s', async (_name, answer) => {
    const { gateway, store, resolve } = setup([one]);
    gateway.enqueue('consultarDE', answer);

    const result = await resolve.execute();

    expect(store.outcomes.size).toBe(0);
    expect(store.notes.has('ev-1')).toBe(true);
    expect(result).toMatchObject({ approved: 0, rejected: 0, inconclusive: 1 });
  });

  it('never resends an event: it only queries', async () => {
    const { gateway, resolve } = setup([
      one,
      { id: 'ev-2', cdc: OTHER_CDC, sentAt: minutesAgo(60), missedAt: null },
    ]);
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', [cancellationOf(CDC)]));
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado('<rDE/>', []));

    await resolve.execute();

    expect(gateway.callsTo('enviarEventos')).toEqual([]);
    expect(gateway.callsTo('consultarDE')).toHaveLength(2);
  });

  it('does nothing when no event is unresolved', async () => {
    const { gateway, resolve } = setup([]);

    expect(await resolve.execute()).toEqual({
      swept: 0,
      approved: 0,
      rejected: 0,
      inconclusive: 0,
    });
    expect(gateway.calls).toEqual([]);
  });
});
