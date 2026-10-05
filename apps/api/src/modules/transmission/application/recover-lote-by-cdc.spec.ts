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

function setup(state: LoteRecoveryState | null, nowOffsetMs = 10 * MINUTE, applies = true) {
  const gateway = new FakeSifenGateway();
  const store = new InMemoryRecoveryStore(state, applies);
  const now = new Date(HANDED_OVER_AT.getTime() + nowOffsetMs);
  let next = 100n;
  const recover = new RecoverLoteByCdc({
    gateway,
    store,
    nextRequestId: () => Promise.resolve(next++),
    now: () => now,
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
});
