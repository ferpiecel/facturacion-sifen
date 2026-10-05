import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import {
  RecoverLoteByCdc,
  type LoteRecoveryGuard,
  type LoteRecoveryOutcome,
  type LoteRecoveryState,
  type LoteRecoveryStore,
} from './recover-lote-by-cdc.js';

const MINUTE = 60_000;
const HANDED_OVER_AT = new Date('2026-09-24T10:00:00Z');
const cdcA = '01444444017001001000000122026092211234567890'.slice(0, 44);
const cdcB = '01444444017001001000000222026092211234567891'.slice(0, 44);
const xmlOf = (cdc: string): string => `<rDE><DE Id="${cdc}"/></rDE>`;

class InMemoryRecoveryStore implements LoteRecoveryStore {
  readonly recorded: { outcome: LoteRecoveryOutcome; guard: LoteRecoveryGuard }[] = [];

  constructor(
    private state: LoteRecoveryState | null,
    private readonly applies = true,
  ) {}

  load(): Promise<LoteRecoveryState | null> {
    return Promise.resolve(this.state);
  }

  record(_loteId: string, outcome: LoteRecoveryOutcome, guard: LoteRecoveryGuard) {
    if (this.applies) this.recorded.push({ outcome, guard });
    return Promise.resolve(this.applies);
  }
}

const recoveryLote = (overrides: Partial<LoteRecoveryState> = {}): LoteRecoveryState => ({
  loteId: 'lote-1',
  status: 'recovery',
  lastPolledAt: HANDED_OVER_AT,
  cdcs: [cdcA, cdcB],
  ...overrides,
});

function setup(
  state: LoteRecoveryState | null,
  nowOffsetMs = 10 * MINUTE,
  applies = true,
  options: { maxQueries?: number } = {},
) {
  const gateway = new FakeSifenGateway();
  const store = new InMemoryRecoveryStore(state, applies);
  const now = new Date(HANDED_OVER_AT.getTime() + nowOffsetMs);
  let next = 100n;
  const recover = new RecoverLoteByCdc({
    gateway,
    store,
    nextRequestId: () => Promise.resolve(next++),
    now: () => now,
    ...options,
  });
  return { gateway, store, recover, now };
}

describe('RecoverLoteByCdc', () => {
  it('does nothing for an unknown lote', async () => {
    const { recover, gateway } = setup(null);
    expect(await recover.execute({ loteId: 'lote-1' })).toEqual({ status: 'not-found' });
    expect(gateway.calls).toHaveLength(0);
  });

  it.each(['pending', 'sending', 'sent', 'rejected'])(
    'does not recover a lote in %s state',
    async (status) => {
      const { recover, gateway, store } = setup(recoveryLote({ status }));
      expect(await recover.execute({ loteId: 'lote-1' })).toEqual({ status: 'not-recoverable' });
      expect(gateway.calls).toHaveLength(0);
      expect(store.recorded).toHaveLength(0);
    },
  );

  it('does not query again before 10 minutes after the last query', async () => {
    const { recover, gateway } = setup(recoveryLote(), 9 * MINUTE);
    expect(await recover.execute({ loteId: 'lote-1' })).toEqual({ status: 'not-due' });
    expect(gateway.calls).toHaveLength(0);
  });

  it.each(['unknown', 'recovery', 'processed'])(
    'recovers a %s lote by CDC and never resends it',
    async (status) => {
      const { recover, gateway, store } = setup(recoveryLote({ status, lastPolledAt: null }));
      gateway.enqueue(
        'consultarDE',
        sifenScenarios.cdcEncontrado(xmlOf(cdcA)),
        sifenScenarios.cdcInexistente(),
      );
      const result = await recover.execute({ loteId: 'lote-1' });
      expect(result).toMatchObject({ status: 'incomplete', resolutions: [{ cdc: cdcA }] });
      expect(store.recorded[0].guard).toMatchObject({ expectedStatus: status });
      expect(gateway.callsTo('consultarDE')).toHaveLength(2);
      expect(gateway.callsTo('enviarLote')).toHaveLength(0);
    },
  );

  it('a processed lote with nothing pending is not recoverable', async () => {
    const { recover, gateway } = setup(recoveryLote({ status: 'processed', cdcs: [] }));
    expect(await recover.execute({ loteId: 'lote-1' })).toEqual({ status: 'not-recoverable' });
    expect(gateway.calls).toHaveLength(0);
  });

  it('queries at once when the lote was never queried', async () => {
    const { recover, gateway } = setup(recoveryLote({ lastPolledAt: null }), 0);
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(xmlOf(cdcA)));
    await recover.execute({ loteId: 'lote-1' });
    expect(gateway.callsTo('consultarDE')).toHaveLength(2);
  });

  it('queries every pending CDC with its own dId and never resends the lote', async () => {
    const { recover, gateway } = setup(recoveryLote());
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(xmlOf(cdcA)));
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(xmlOf(cdcB)));
    await recover.execute({ loteId: 'lote-1' });
    expect(gateway.callsTo('consultarDE')).toEqual([
      [{ dId: 100n, cdc: cdcA }],
      [{ dId: 101n, cdc: cdcB }],
    ]);
    expect(gateway.callsTo('enviarLote')).toHaveLength(0);
    expect(gateway.callsTo('enviarDESincronico')).toHaveLength(0);
  });

  it('0422 for every CDC approves each document and recovers the lote', async () => {
    const { recover, gateway, store, now } = setup(recoveryLote());
    gateway.enqueue(
      'consultarDE',
      sifenScenarios.cdcEncontrado(xmlOf(cdcA)),
      sifenScenarios.cdcEncontrado(xmlOf(cdcB)),
    );
    const result = await recover.execute({ loteId: 'lote-1' });
    const expected = {
      resolutions: [
        { cdc: cdcA, status: 'approved', messages: [{ code: '0422', message: 'CDC encontrado' }] },
        { cdc: cdcB, status: 'approved', messages: [{ code: '0422', message: 'CDC encontrado' }] },
      ],
      unresolved: [],
    };
    expect(result).toEqual({ status: 'recovered', ...expected });
    expect(store.recorded).toEqual([
      {
        outcome: expected,
        guard: {
          expectedStatus: 'recovery',
          expectedLastPolledAt: HANDED_OVER_AT,
          recoveredAt: now,
        },
      },
    ]);
  });

  it('0420 leaves the CDC unresolved: it may only mean SIFEN has not processed it yet', async () => {
    const { recover, gateway } = setup(recoveryLote());
    gateway.enqueue(
      'consultarDE',
      sifenScenarios.cdcEncontrado(xmlOf(cdcA)),
      sifenScenarios.cdcInexistente(),
    );
    const result = await recover.execute({ loteId: 'lote-1' });
    expect(result).toMatchObject({
      status: 'incomplete',
      resolutions: [{ cdc: cdcA, status: 'approved' }],
      unresolved: [{ cdc: cdcB, reason: expect.stringContaining('0420') as string }],
    });
  });

  it('flags only a 0420 as absent, so the store can tell it from a failed or odd answer', async () => {
    const { recover, gateway } = setup(recoveryLote({ cdcs: [cdcA, cdcB, 'c'.repeat(44)] }));
    gateway.enqueue(
      'consultarDE',
      sifenScenarios.cdcInexistente(),
      new SifenTimeoutError('consultarDE'),
      sifenScenarios.rucCertificadoSinPermiso(),
    );
    const result = await recover.execute({ loteId: 'lote-1' });
    expect(result).toMatchObject({
      unresolved: [
        { cdc: cdcA, absent: true },
        { cdc: cdcB, absent: false },
        { cdc: 'c'.repeat(44), absent: false },
      ],
    });
  });

  it('a failed query leaves its CDC unresolved, keeps only the error class, and goes on', async () => {
    const { recover, gateway } = setup(recoveryLote());
    gateway.enqueue(
      'consultarDE',
      new SifenTimeoutError('consultarDE', {
        cause: new Error('connect https://sifen.example/secret'),
      }),
      sifenScenarios.cdcEncontrado(xmlOf(cdcB)),
    );
    const result = await recover.execute({ loteId: 'lote-1' });
    expect(result).toMatchObject({
      status: 'incomplete',
      resolutions: [{ cdc: cdcB }],
      unresolved: [{ cdc: cdcA, reason: 'Query failed (SifenTimeoutError)' }],
    });
    expect(JSON.stringify(result)).not.toContain('sifen.example');
  });

  it('an unexpected code leaves the CDC unresolved', async () => {
    const { recover, gateway } = setup(recoveryLote({ cdcs: [cdcA] }));
    gateway.enqueue('consultarDE', sifenScenarios.rucCertificadoSinPermiso());
    const result = await recover.execute({ loteId: 'lote-1' });
    expect(result).toMatchObject({
      status: 'incomplete',
      unresolved: [{ cdc: cdcA, reason: expect.stringContaining('0421') as string }],
    });
  });

  it('a 0422 whose XML is not the queried DE leaves the CDC unresolved', async () => {
    const { recover, gateway } = setup(recoveryLote({ cdcs: [cdcA] }));
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(xmlOf(cdcB)));
    const result = await recover.execute({ loteId: 'lote-1' });
    expect(result).toMatchObject({ status: 'incomplete', resolutions: [] });
  });

  it.each([
    ['only references the CDC', `<rDE><DE Id="${cdcB}"><dCdCDERef>${cdcA}</dCdCDERef></DE></rDE>`],
    ['has a longer Id that starts with the CDC', `<rDE><DE Id="${cdcA}9"/></rDE>`],
    ['has no DE Id', `<rDE><DE>${cdcA}</DE></rDE>`],
  ])('a 0422 whose XML %s is not the queried DE', async (_case, xml) => {
    const { recover, gateway } = setup(recoveryLote({ cdcs: [cdcA] }));
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(xml));
    const result = await recover.execute({ loteId: 'lote-1' });
    expect(result).toMatchObject({
      status: 'incomplete',
      resolutions: [],
      unresolved: [{ cdc: cdcA }],
    });
  });

  it('a lote with no pending CDC is recovered without querying', async () => {
    const { recover, gateway } = setup(recoveryLote({ cdcs: [] }));
    expect(await recover.execute({ loteId: 'lote-1' })).toEqual({
      status: 'recovered',
      resolutions: [],
      unresolved: [],
    });
    expect(gateway.calls).toHaveLength(0);
  });

  it('reports stale when a concurrent run already moved the lote', async () => {
    const { recover, gateway } = setup(recoveryLote({ cdcs: [cdcA] }), 10 * MINUTE, false);
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(xmlOf(cdcA)));
    expect(await recover.execute({ loteId: 'lote-1' })).toEqual({ status: 'stale' });
  });

  describe('maxQueries validation', () => {
    const build = (maxQueries: number) =>
      new RecoverLoteByCdc({
        gateway: new FakeSifenGateway(),
        store: new InMemoryRecoveryStore(null),
        nextRequestId: () => Promise.resolve(1n),
        maxQueries,
      });

    it.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
      'rejects %s at construction: it would silently stop the lote from ever being asked',
      (value) => {
        expect(() => build(value)).toThrow(RangeError);
        expect(() => build(value)).toThrow(/maxQueries/);
      },
    );

    it('accepts 1, the smallest value that still makes progress', () => {
      expect(() => build(1)).not.toThrow();
    });
  });

  describe('bounded and abortable queries', () => {
    const cdcsOf = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => String(i + 1).padStart(44, '0'));
    const found = (cdc: string) => sifenScenarios.cdcEncontrado(xmlOf(cdc));

    it('asks at most maxQueries CDCs per run and leaves the rest pending, never as 0420', async () => {
      const cdcs = cdcsOf(5);
      const { recover, gateway, store } = setup(recoveryLote({ cdcs }), 10 * MINUTE, true, {
        maxQueries: 2,
      });
      gateway.enqueue('consultarDE', found(cdcs[0]), found(cdcs[1]));
      const result = await recover.execute({ loteId: 'lote-1' });
      expect(gateway.callsTo('consultarDE')).toHaveLength(2);
      expect(result).toMatchObject({
        status: 'incomplete',
        resolutions: [{ cdc: cdcs[0] }, { cdc: cdcs[1] }],
      });
      const skipped = store.recorded[0].outcome.unresolved;
      expect(skipped.map((u) => u.cdc)).toEqual(cdcs.slice(2));
      expect(skipped.every((u) => u.skipped === true && !u.absent)).toBe(true);
    });

    it('defaults to 20 queries per run, enough for a lote of 50 over three passes', async () => {
      const cdcs = cdcsOf(25);
      const { recover, gateway } = setup(recoveryLote({ cdcs }));
      await recover.execute({ loteId: 'lote-1' });
      expect(gateway.callsTo('consultarDE')).toHaveLength(20);
    });

    it('does not flag anything skipped when the lote has exactly maxQueries CDCs', async () => {
      const cdcs = cdcsOf(2);
      const { recover, gateway, store } = setup(recoveryLote({ cdcs }), 10 * MINUTE, true, {
        maxQueries: 2,
      });
      gateway.enqueue('consultarDE', found(cdcs[0]), found(cdcs[1]));
      expect(await recover.execute({ loteId: 'lote-1' })).toMatchObject({ status: 'recovered' });
      expect(store.recorded[0].outcome.unresolved).toEqual([]);
    });

    it('stops between queries once the signal aborts, records what it learned, skips the rest', async () => {
      const cdcs = cdcsOf(4);
      const controller = new AbortController();
      const { recover, gateway, store } = setup(recoveryLote({ cdcs }));
      gateway.enqueue('consultarDE', found(cdcs[0]));
      const original = gateway.consultarDE.bind(gateway);
      gateway.consultarDE = async (request) => {
        const answer = await original(request);
        controller.abort();
        return answer;
      };
      const result = await recover.execute({ loteId: 'lote-1', signal: controller.signal });
      expect(gateway.callsTo('consultarDE')).toHaveLength(1);
      expect(result).toMatchObject({ status: 'incomplete', resolutions: [{ cdc: cdcs[0] }] });
      expect(store.recorded).toHaveLength(1);
      expect(store.recorded[0].outcome.unresolved.map((u) => u.cdc)).toEqual(cdcs.slice(1));
      expect(store.recorded[0].outcome.unresolved.every((u) => u.skipped === true)).toBe(true);
    });

    it('does nothing, not even stamping the query time, when already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const { recover, gateway, store } = setup(recoveryLote());
      expect(await recover.execute({ loteId: 'lote-1', signal: controller.signal })).toEqual({
        status: 'aborted',
      });
      expect(gateway.calls).toHaveLength(0);
      expect(store.recorded).toHaveLength(0);
    });
  });
});
