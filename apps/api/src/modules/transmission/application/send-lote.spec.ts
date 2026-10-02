import {
  FakeSifenGateway,
  SifenTimeoutError,
  SifenTransportError,
  sifenScenarios,
} from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import { buildCdc } from '../../emission/domain/cdc.js';
import type { Lote } from '../domain/lote-builder.js';
import { SendLote, type LoteDispatchOutcome, type LoteDispatchStore } from './send-lote.js';

class InMemoryLoteStore implements LoteDispatchStore {
  readonly states = new Map<string, string>();
  readonly outcomes = new Map<string, LoteDispatchOutcome>();

  constructor(pending: readonly string[]) {
    for (const id of pending) this.states.set(id, 'pending');
  }

  claim(loteId: string): Promise<boolean> {
    if (this.states.get(loteId) !== 'pending') return Promise.resolve(false);
    this.states.set(loteId, 'sending');
    return Promise.resolve(true);
  }

  record(loteId: string, outcome: LoteDispatchOutcome): Promise<void> {
    this.states.set(loteId, outcome.status);
    this.outcomes.set(loteId, outcome);
    return Promise.resolve();
  }
}

const cdc = (n: number): string =>
  buildCdc({
    documentType: '01',
    rucBase: '44444401',
    rucDv: 7,
    establishment: '001',
    point: '001',
    documentNumber: String(n),
    taxpayerType: 2,
    issueDate: '2026-09-22',
    emissionType: 1,
    securityCode: '123456789',
  });

const lote: Lote = {
  rucBase: '44444401',
  rucDv: 7,
  documentType: '01',
  documents: [
    { cdc: cdc(1), xml: '<rDE>1</rDE>' },
    { cdc: cdc(2), xml: '<rDE>2</rDE>' },
  ],
};

function setup() {
  const gateway = new FakeSifenGateway();
  const store = new InMemoryLoteStore(['lote-1']);
  return { gateway, store, send: new SendLote({ gateway, store }) };
}

describe('SendLote', () => {
  it('sends the lote XMLs once with the given dId', async () => {
    const { gateway, send } = setup();
    await send.execute({ loteId: 'lote-1', dId: 7n, lote });
    expect(gateway.callsTo('enviarLote')).toEqual([
      [{ dId: 7n, des: ['<rDE>1</rDE>', '<rDE>2</rDE>'] }],
    ]);
  });

  it('stores dProtConsLote on 0300', async () => {
    const { gateway, store, send } = setup();
    gateway.enqueue('enviarLote', sifenScenarios.loteRecibido('4500123'));
    const outcome = await send.execute({ loteId: 'lote-1', dId: 1n, lote });
    expect(outcome).toEqual({ status: 'sent', dProtConsLote: '4500123' });
    expect(store.outcomes.get('lote-1')).toEqual(outcome);
  });

  it('records code and reason on 0301', async () => {
    const { gateway, store, send } = setup();
    gateway.enqueue('enviarLote', sifenScenarios.loteNoEncolado('RUC bloqueado'));
    const outcome = await send.execute({ loteId: 'lote-1', dId: 1n, lote });
    expect(outcome).toEqual({ status: 'rejected', code: '0301', reason: 'RUC bloqueado' });
    expect(store.states.get('lote-1')).toBe('rejected');
  });

  it.each([
    ['timeout', new SifenTimeoutError('enviarLote')],
    ['transport failure', new SifenTransportError('enviarLote')],
  ])('marks the lote unknown on %s and never resends', async (_name, error) => {
    const { gateway, store, send } = setup();
    gateway.enqueue('enviarLote', error);
    const outcome = await send.execute({ loteId: 'lote-1', dId: 1n, lote });
    expect(outcome.status).toBe('unknown');
    expect(store.states.get('lote-1')).toBe('unknown');
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
  });

  it('marks the lote unknown on 0300 without a protocol', async () => {
    const { gateway, send } = setup();
    gateway.enqueue('enviarLote', { dCodRes: '0300', dMsgRes: 'ok', dProtConsLote: null });
    expect((await send.execute({ loteId: 'lote-1', dId: 1n, lote })).status).toBe('unknown');
  });

  it('marks the lote unknown on an unexpected code', async () => {
    const { gateway, send } = setup();
    gateway.enqueue('enviarLote', { dCodRes: '9999', dMsgRes: 'x', dProtConsLote: null });
    expect((await send.execute({ loteId: 'lote-1', dId: 1n, lote })).status).toBe('unknown');
  });

  it('does not call SIFEN for a lote that was already claimed', async () => {
    const { gateway, send } = setup();
    await send.execute({ loteId: 'lote-1', dId: 1n, lote });
    const again = await send.execute({ loteId: 'lote-1', dId: 2n, lote });
    expect(again).toEqual({ status: 'already-claimed' });
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
  });

  it('claims the lote before calling SIFEN', async () => {
    const { gateway, store, send } = setup();
    let seen: string | undefined;
    const original = gateway.enviarLote.bind(gateway);
    gateway.enviarLote = (request) => {
      seen = store.states.get('lote-1');
      return original(request);
    };
    await send.execute({ loteId: 'lote-1', dId: 1n, lote });
    expect(seen).toBe('sending');
  });
});
