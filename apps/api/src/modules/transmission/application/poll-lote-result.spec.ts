import {
  FakeSifenGateway,
  SifenTimeoutError,
  sifenScenarios,
  toCdc,
  type SifenResultadoDE,
} from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import {
  PollLoteResult,
  type LotePollOutcome,
  type LotePollState,
  type LotePollStore,
} from './poll-lote-result.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SENT_AT = new Date('2026-09-22T10:00:00Z');
const cdcA = '01444444017001001000000122026092211234567890'.slice(0, 44);
const cdcB = '01444444017001001000000222026092211234567891'.slice(0, 44);

class InMemoryPollStore implements LotePollStore {
  readonly outcomes: LotePollOutcome[] = [];

  constructor(private state: LotePollState | null) {}

  load(): Promise<LotePollState | null> {
    return Promise.resolve(this.state);
  }

  record(_loteId: string, outcome: LotePollOutcome): Promise<void> {
    this.outcomes.push(outcome);
    return Promise.resolve();
  }
}

const sentLote = (overrides: Partial<LotePollState> = {}): LotePollState => ({
  loteId: 'lote-1',
  status: 'sent',
  dProtConsLote: '9876543210',
  nextPollAt: new Date(SENT_AT.getTime() + 10 * MINUTE),
  pollDeadlineAt: new Date(SENT_AT.getTime() + 48 * HOUR),
  cdcs: [cdcA, cdcB],
  ...overrides,
});

const resultado = (cdc: string, dEstRes: string, dCodRes = '0260'): SifenResultadoDE => ({
  cdc: toCdc(cdc),
  dEstRes,
  mensajes: [{ dCodRes, dMsgRes: `msg ${dCodRes}` }],
});

function setup(state: LotePollState | null, nowOffsetMs: number) {
  const gateway = new FakeSifenGateway();
  const store = new InMemoryPollStore(state);
  const now = new Date(SENT_AT.getTime() + nowOffsetMs);
  const poll = new PollLoteResult({ gateway, store, now: () => now });
  return { gateway, store, poll, now };
}

const reasonOf = (outcome: { status: string; reason?: string }): string => outcome.reason ?? '';

const run = (poll: PollLoteResult) => poll.execute({ loteId: 'lote-1', dId: 7n });

describe('PollLoteResult', () => {
  it('does nothing for an unknown lote', async () => {
    const { poll, gateway } = setup(null, 11 * MINUTE);
    expect(await run(poll)).toEqual({ status: 'not-found' });
    expect(gateway.callsTo('consultarLote')).toHaveLength(0);
  });

  it.each(['pending', 'sending', 'rejected', 'unknown', 'processed', 'recovery'])(
    'does not poll a lote in %s state',
    async (status) => {
      const { poll, gateway, store } = setup(sentLote({ status }), 11 * MINUTE);
      expect(await run(poll)).toEqual({ status: 'not-pollable' });
      expect(gateway.callsTo('consultarLote')).toHaveLength(0);
      expect(store.outcomes).toHaveLength(0);
    },
  );

  it('does not call SIFEN before next_poll_at', async () => {
    const { poll, gateway, store } = setup(sentLote(), 9 * MINUTE);
    expect(await run(poll)).toEqual({ status: 'not-due' });
    expect(gateway.callsTo('consultarLote')).toHaveLength(0);
    expect(store.outcomes).toHaveLength(0);
  });

  it('queries exactly at next_poll_at with the protocol and dId', async () => {
    const { poll, gateway } = setup(sentLote(), 10 * MINUTE);
    gateway.enqueue('consultarLote', sifenScenarios.loteEnProcesamiento());
    await run(poll);
    expect(gateway.callsTo('consultarLote')).toEqual([[{ dId: 7n, dProtConsLote: '9876543210' }]]);
  });

  it('0361 keeps polling and reschedules 10 minutes after now, never earlier', async () => {
    const { poll, gateway, store, now } = setup(sentLote(), 25 * MINUTE);
    gateway.enqueue('consultarLote', sifenScenarios.loteEnProcesamiento());
    const outcome = await run(poll);
    expect(outcome).toMatchObject({
      status: 'pending',
      nextPollAt: new Date(now.getTime() + 10 * MINUTE),
    });
    expect(store.outcomes).toEqual([outcome]);
  });

  it('0362 maps each DE by dEstRes and marks the lote processed', async () => {
    const { poll, gateway, store } = setup(sentLote(), 11 * MINUTE);
    gateway.enqueue(
      'consultarLote',
      sifenScenarios.loteConcluido([
        resultado(cdcA, 'Aprobado'),
        resultado(cdcB, 'Rechazado', '1000'),
      ]),
    );
    const outcome = await run(poll);
    expect(outcome).toEqual({
      status: 'processed',
      resolutions: [
        { cdc: cdcA, status: 'approved', messages: [{ code: '0260', message: 'msg 0260' }] },
        { cdc: cdcB, status: 'rejected', messages: [{ code: '1000', message: 'msg 1000' }] },
      ],
      needsRecovery: [],
    });
    expect(store.outcomes).toEqual([outcome]);
  });

  it('0362 keeps the observations of an "Aprobado con observación" DE', async () => {
    const { poll, gateway } = setup(sentLote({ cdcs: [cdcA] }), 11 * MINUTE);
    gateway.enqueue(
      'consultarLote',
      sifenScenarios.loteConcluido([resultado(cdcA, 'Aprobado con observación', '1005')]),
    );
    expect(await run(poll)).toMatchObject({
      status: 'processed',
      resolutions: [
        {
          cdc: cdcA,
          status: 'approved_with_observations',
          messages: [{ code: '1005', message: 'msg 1005' }],
        },
      ],
    });
  });

  it('matches dEstRes ignoring case and accents', async () => {
    const { poll, gateway } = setup(sentLote({ cdcs: [cdcA, cdcB] }), 11 * MINUTE);
    gateway.enqueue(
      'consultarLote',
      sifenScenarios.loteConcluido([
        resultado(cdcA, 'APROBADO CON OBSERVACION'),
        resultado(cdcB, ' rechazado '),
      ]),
    );
    expect(await run(poll)).toMatchObject({
      resolutions: [{ status: 'approved_with_observations' }, { status: 'rejected' }],
    });
  });

  it('sends DEs that are missing from the answer or have an unknown dEstRes to recovery', async () => {
    const { poll, gateway } = setup(sentLote(), 11 * MINUTE);
    gateway.enqueue('consultarLote', sifenScenarios.loteConcluido([resultado(cdcA, 'Pendiente')]));
    expect(await run(poll)).toEqual({
      status: 'processed',
      resolutions: [],
      needsRecovery: [cdcA, cdcB],
    });
  });

  it('ignores results for CDCs that are not in the lote', async () => {
    const other = '01444444017001001000000922026092211234567899'.slice(0, 44);
    const { poll, gateway } = setup(sentLote({ cdcs: [cdcA] }), 11 * MINUTE);
    gateway.enqueue(
      'consultarLote',
      sifenScenarios.loteConcluido([resultado(cdcA, 'Aprobado'), resultado(other, 'Aprobado')]),
    );
    expect(await run(poll)).toMatchObject({
      resolutions: [{ cdc: cdcA }],
      needsRecovery: [],
    });
  });

  it.each([
    ['0364', sifenScenarios.consultaExtemporanea()],
    ['0360', sifenScenarios.loteInexistente()],
  ])('%s hands the lote off to recovery', async (code, response) => {
    const { poll, gateway, store } = setup(sentLote(), 11 * MINUTE);
    gateway.enqueue('consultarLote', response);
    const outcome = await run(poll);
    expect(outcome).toMatchObject({ status: 'recovery' });
    expect(reasonOf(outcome)).toContain(code);
    expect(store.outcomes).toEqual([outcome]);
  });

  it('hands off to recovery past the 48 h window without calling SIFEN', async () => {
    const { poll, gateway, store } = setup(sentLote(), 48 * HOUR + 1);
    const outcome = await run(poll);
    expect(outcome).toMatchObject({ status: 'recovery' });
    expect(reasonOf(outcome)).toContain('48 h');
    expect(gateway.callsTo('consultarLote')).toHaveLength(0);
    expect(store.outcomes).toEqual([outcome]);
  });

  it('still queries at exactly the deadline', async () => {
    const { poll, gateway } = setup(sentLote(), 48 * HOUR);
    gateway.enqueue('consultarLote', sifenScenarios.loteEnProcesamiento());
    expect(await run(poll)).toMatchObject({ status: 'pending' });
  });

  it('treats a gateway error as a retryable pending outcome', async () => {
    const { poll, gateway, now } = setup(sentLote(), 11 * MINUTE);
    gateway.enqueue('consultarLote', new SifenTimeoutError('consultarLote'));
    const outcome = await run(poll);
    expect(outcome).toMatchObject({
      status: 'pending',
      nextPollAt: new Date(now.getTime() + 10 * MINUTE),
    });
    expect(reasonOf(outcome)).toContain('timed out');
  });

  it('treats an unexpected code as pending, quoting it', async () => {
    const { poll, gateway } = setup(sentLote(), 11 * MINUTE);
    gateway.enqueue('consultarLote', { dCodRes: '0999', dMsgRes: 'raro', resultados: [] });
    const outcome = await run(poll);
    expect(outcome).toMatchObject({ status: 'pending' });
    expect(reasonOf(outcome)).toContain('0999');
  });

  it('calls SIFEN once per execution', async () => {
    const { poll, gateway } = setup(sentLote(), 11 * MINUTE);
    gateway.enqueue('consultarLote', sifenScenarios.loteEnProcesamiento());
    await run(poll);
    expect(gateway.callsTo('consultarLote')).toHaveLength(1);
  });
});
