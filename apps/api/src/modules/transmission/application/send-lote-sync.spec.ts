import {
  FakeSifenGateway,
  SifenCircuitOpenError,
  SifenTenantUnavailableError,
  SifenTimeoutError,
} from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import type { Lote } from '../domain/lote-builder.js';
import type { DocumentResolution } from './poll-lote-result.js';
import { SendLote, type LoteDispatchOutcome, type LoteDispatchStore } from './send-lote.js';

/** Spec: HU-E6-06. A flagged tenant sends a single DE through siRecepDE; 1264 falls back to the lote. */
class Store implements LoteDispatchStore {
  state = 'pending';
  outcomes: LoteDispatchOutcome[] = [];
  claim() {
    if (this.state !== 'pending') return Promise.resolve(false);
    this.state = 'sending';
    return Promise.resolve(true);
  }
  release() {
    this.state = 'pending';
    return Promise.resolve();
  }
  record(_loteId: string, outcome: LoteDispatchOutcome) {
    this.state = outcome.status;
    this.outcomes.push(outcome);
    return Promise.resolve();
  }
}

const cdc = '0'.repeat(44);
const one: Lote = {
  rucBase: '44444401',
  rucDv: 7,
  documentType: '01',
  documents: [{ cdc, xml: '<rDE>1</rDE>' }],
};
const two: Lote = {
  ...one,
  documents: [...one.documents, { cdc: '1'.repeat(44), xml: '<rDE>2</rDE>' }],
};

function setup(enabled = true) {
  const gateway = new FakeSifenGateway();
  const store = new Store();
  const sync = {
    enabled: enabled,
    disabled: [] as string[],
    settled: [] as DocumentResolution[],
    isEnabled() {
      return Promise.resolve(this.enabled);
    },
    disable(reason: string) {
      this.enabled = false;
      this.disabled.push(reason);
      return Promise.resolve();
    },
    recordSettled(_loteId: string, resolution: DocumentResolution) {
      store.state = 'processed';
      this.settled.push(resolution);
      return Promise.resolve();
    },
  };
  return { gateway, store, sync, send: new SendLote({ gateway, store, sync }) };
}

describe('SendLote synchronous path', () => {
  it('sends a single DE through siRecepDE and settles it from the answer', async () => {
    const { gateway, store, sync, send } = setup();
    const outcome = await send.execute({ loteId: 'l', dId: 5n, lote: one });
    expect(gateway.callsTo('enviarDESincronico')).toEqual([[{ dId: 5n, de: '<rDE>1</rDE>' }]]);
    expect(gateway.callsTo('enviarLote')).toEqual([]);
    expect(outcome.status).toBe('processed');
    expect(sync.settled).toEqual([
      {
        cdc,
        status: 'approved',
        messages: [{ code: '0260', message: 'Autorización del DE satisfactoria' }],
      },
    ]);
    expect(store.state).toBe('processed');
  });

  it('settles a rejected DE as rejected', async () => {
    const { gateway, sync, send } = setup();
    gateway.enqueue('enviarDESincronico', {
      dCodRes: '1000',
      dMsgRes: 'CDC mal',
      dEstRes: 'Rechazado',
      dProtAut: null,
    });
    await send.execute({ loteId: 'l', dId: 5n, lote: one });
    expect(sync.settled[0]?.status).toBe('rejected');
  });

  it('on 1264 disables the flag and falls back to the lote with the same claim', async () => {
    const { gateway, store, sync, send } = setup();
    gateway.enqueue('enviarDESincronico', {
      dCodRes: '1264',
      dMsgRes: 'RUC no habilitado',
      dEstRes: 'Rechazado',
      dProtAut: null,
    });
    const outcome = await send.execute({ loteId: 'l', dId: 5n, lote: one });
    expect(sync.disabled).toHaveLength(1);
    expect(gateway.callsTo('enviarLote')).toEqual([[{ dId: 5n, des: ['<rDE>1</rDE>'] }]]);
    expect(outcome.status).toBe('sent');
    expect(store.state).toBe('sent');
  });

  it('still falls back to the lote when clearing the flag fails', async () => {
    const { gateway, store, sync, send } = setup();
    sync.disable = () => Promise.reject(new Error('db down'));
    gateway.enqueue('enviarDESincronico', {
      dCodRes: '1264',
      dMsgRes: 'RUC no habilitado',
      dEstRes: 'Rechazado',
      dProtAut: null,
    });
    const outcome = await send.execute({ loteId: 'l', dId: 5n, lote: one });
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
    expect(outcome.status).toBe('sent');
    expect(store.state).toBe('sent');
  });

  it('never sends a lote of several DEs by sync', async () => {
    const { gateway, send } = setup();
    await send.execute({ loteId: 'l', dId: 5n, lote: two });
    expect(gateway.callsTo('enviarDESincronico')).toEqual([]);
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
  });

  it('uses the lote when the tenant has no flag', async () => {
    const { gateway, send } = setup(false);
    await send.execute({ loteId: 'l', dId: 5n, lote: one });
    expect(gateway.callsTo('enviarDESincronico')).toEqual([]);
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
  });

  it('marks the lote unknown after an unanswered sync call and never resends', async () => {
    const { gateway, store, send } = setup();
    gateway.enqueue('enviarDESincronico', new SifenTimeoutError('enviarDESincronico'));
    const outcome = await send.execute({ loteId: 'l', dId: 5n, lote: one });
    expect(outcome.status).toBe('unknown');
    expect(store.state).toBe('unknown');
    expect(gateway.callsTo('enviarLote')).toEqual([]);
  });

  it('leaves an unrecognised answer to recovery by CDC', async () => {
    const { gateway, store, send } = setup();
    gateway.enqueue('enviarDESincronico', {
      dCodRes: '0301',
      dMsgRes: '?',
      dEstRes: null,
      dProtAut: null,
    });
    expect((await send.execute({ loteId: 'l', dId: 5n, lote: one })).status).toBe('unknown');
    expect(store.state).toBe('unknown');
  });

  it('leaves the lote to recovery by CDC when storing the settlement fails, never resending', async () => {
    const { gateway, store, sync, send } = setup();
    gateway.enqueue('enviarDESincronico', {
      dCodRes: '0260',
      dMsgRes: 'Autorización del DE satisfactoria',
      dEstRes: 'Aprobado',
      dProtAut: '1',
    });
    sync.recordSettled = () => Promise.reject(new Error('db down'));
    const outcome = await send.execute({ loteId: 'l', dId: 5n, lote: one });
    expect(outcome.status).toBe('unknown');
    expect(store.state).toBe('unknown');
    expect(gateway.callsTo('enviarDESincronico')).toHaveLength(1);
    expect(gateway.callsTo('enviarLote')).toEqual([]);
  });

  it('releases the claim and defers when the circuit is open', async () => {
    const { gateway, store, send } = setup();
    gateway.enqueue(
      'enviarDESincronico',
      new SifenCircuitOpenError('enviarDESincronico', new Date(9)),
    );
    expect((await send.execute({ loteId: 'l', dId: 5n, lote: one })).status).toBe('deferred');
    expect(store.state).toBe('pending');
  });

  it('defers (nothing processed) when the tenant cannot call SIFEN at all', async () => {
    const { gateway, store, send } = setup();
    gateway.enqueue(
      'enviarDESincronico',
      new SifenTenantUnavailableError('enviarDESincronico', new Date(9)),
    );
    expect(await send.execute({ loteId: 'l', dId: 5n, lote: one })).toMatchObject({
      status: 'deferred',
      retryAt: new Date(9),
    });
    expect(store.state).toBe('pending');
  });
});
