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
    this.notes.set(id, note);
    return Promise.resolve();
  }
  record(outcomes: ReadonlyMap<string, EventOutcome>) {
    for (const [id, outcome] of outcomes) this.outcomes.set(id, outcome);
    return Promise.resolve();
  }
}

function setup(unresolved: readonly UnresolvedCancellation[], swept = 0) {
  const gateway = new FakeSifenGateway();
  const store = new InMemoryStore(unresolved, swept);
  const resolve = new ResolveUnknownEvents({
    gateway,
    store,
    nextRequestId: () => Promise.resolve(90n),
    now: () => NOW,
    staleSendingAfterMs: 30 * 60_000,
    settleAfterMs: 15 * 60_000,
    limit: 10,
  });
  return { gateway, store, resolve };
}

const one: UnresolvedCancellation = { id: 'ev-1', cdc: CDC };

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

  it('settles as rejected, locally, when the document has no such cancellation', async () => {
    const { gateway, store, resolve } = setup([one]);
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
    const { gateway, resolve } = setup([one, { id: 'ev-2', cdc: OTHER_CDC }]);
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
