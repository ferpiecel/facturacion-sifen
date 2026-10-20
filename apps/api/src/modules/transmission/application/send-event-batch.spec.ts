import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import { DuplicateEventIdError } from '../domain/event-batch.js';
import {
  ALREADY_PROCESSED_CODES,
  LOCAL_XSD_CODE,
  SendEventBatch,
  type EventBatchStore,
  type EventOutcome,
  type PendingEvent,
} from './send-event-batch.js';

const event = (n: number): PendingEvent => ({
  id: `row-${String(n)}`,
  eventId: BigInt(n),
  signedXml: `<gGroupGesEve>${String(n)}</gGroupGesEve>`,
});

class InMemoryEventStore implements EventBatchStore {
  readonly claims: { ids: readonly string[]; dId: bigint }[] = [];
  readonly outcomes = new Map<string, EventOutcome>();
  readonly rejectedUnsent = new Map<string, { code: string; message: string }>();

  constructor(
    private readonly signed: readonly PendingEvent[],
    private readonly takenByAnother: ReadonlySet<string> = new Set(),
  ) {}

  signedEvents(limit: number) {
    return Promise.resolve(this.signed.slice(0, limit));
  }

  claim(ids: readonly string[], dId: bigint) {
    this.claims.push({ ids, dId });
    return Promise.resolve(
      this.signed.filter((e) => ids.includes(e.id) && !this.takenByAnother.has(e.id)),
    );
  }

  rejectUnsent(rejections: ReadonlyMap<string, { code: string; message: string }>) {
    for (const [id, rejection] of rejections) this.rejectedUnsent.set(id, rejection);
    return Promise.resolve();
  }

  record(outcomes: ReadonlyMap<string, EventOutcome>) {
    for (const [id, outcome] of outcomes) this.outcomes.set(id, outcome);
    return Promise.resolve();
  }
}

const valid = () => ({ valid: true, errors: [] });

function setup(
  signed: readonly PendingEvent[],
  options: {
    takenByAnother?: ReadonlySet<string>;
    validate?: (xml: string) => { valid: boolean; errors: { message: string }[] };
  } = {},
) {
  const gateway = new FakeSifenGateway();
  const store = new InMemoryEventStore(signed, options.takenByAnother);
  const send = new SendEventBatch({
    gateway,
    store,
    nextRequestId: () => Promise.resolve(77n),
    validate: options.validate ?? valid,
  });
  return { gateway, store, send };
}

const ok = (id: string) => ({
  id,
  dEstRes: 'Aprobado',
  mensajes: [{ dCodRes: '0600', dMsgRes: 'Evento registrado correctamente' }],
});
const refused = (id: string, code: string, message: string) => ({
  id,
  dEstRes: 'Rechazado',
  mensajes: [{ dCodRes: code, dMsgRes: message }],
});

describe('SendEventBatch', () => {
  it('sends the signed events in one call and settles each by its own answer', async () => {
    const { gateway, store, send } = setup([event(1), event(2), event(3)]);
    gateway.enqueue(
      'enviarEventos',
      sifenScenarios.eventosProcesados([ok('1'), refused('2', '4009', 'Plazo extemporaneo')]),
    );

    const result = await send.execute();

    expect(gateway.callsTo('enviarEventos')).toEqual([
      [
        {
          dId: 77n,
          eventos: [
            '<gGroupGesEve>1</gGroupGesEve>',
            '<gGroupGesEve>2</gGroupGesEve>',
            '<gGroupGesEve>3</gGroupGesEve>',
          ],
        },
      ],
    ]);
    expect(store.claims).toEqual([{ ids: ['row-1', 'row-2', 'row-3'], dId: 77n }]);
    expect(store.outcomes.get('row-1')).toEqual({
      status: 'approved',
      code: '0600',
      message: 'Evento registrado correctamente',
    });
    expect(store.outcomes.get('row-2')).toEqual({
      status: 'rejected',
      code: '4009',
      message: 'Plazo extemporaneo',
    });
    expect(store.outcomes.get('row-3')).toMatchObject({ status: 'unknown' });
    expect(result).toEqual({ status: 'sent', approved: 1, rejected: 1, unknown: 1 });
  });

  it('leaves every event unknown when the call fails, never throwing and never resending', async () => {
    const { gateway, store, send } = setup([event(1), event(2)]);
    gateway.enqueue('enviarEventos', new SifenTimeoutError('enviarEventos'));

    const result = await send.execute();

    expect(gateway.callsTo('enviarEventos')).toHaveLength(1);
    expect(store.outcomes.get('row-1')).toEqual({
      status: 'unknown',
      reason: 'SIFEN operation "enviarEventos" timed out',
    });
    expect(store.outcomes.get('row-2')).toMatchObject({ status: 'unknown' });
    expect(result).toEqual({ status: 'sent', approved: 0, rejected: 0, unknown: 2 });
  });

  it('sends at most 15 events and leaves the rest unclaimed for the next run', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => event(i + 1));
    const { gateway, store, send } = setup(twenty);
    gateway.enqueue(
      'enviarEventos',
      sifenScenarios.eventosProcesados(twenty.slice(0, 15).map((e) => ok(String(e.eventId)))),
    );

    const result = await send.execute();

    expect(gateway.callsTo('enviarEventos')[0]?.[0].eventos).toHaveLength(15);
    expect(store.claims[0]?.ids).toHaveLength(15);
    expect(store.outcomes.size).toBe(15);
    expect(result).toMatchObject({ approved: 15 });
  });

  it('refuses a repeated event id before claiming or sending anything', async () => {
    const { gateway, store, send } = setup([event(1), { ...event(2), eventId: 1n }]);

    await expect(send.execute()).rejects.toThrow(DuplicateEventIdError);

    expect(store.claims).toEqual([]);
    expect(gateway.callsTo('enviarEventos')).toEqual([]);
  });

  it('rejects locally, before claiming, an event that fails the XSD, and sends the others', async () => {
    const { gateway, store, send } = setup([event(1), event(2)], {
      validate: (xml) =>
        xml.includes('>1<')
          ? { valid: false, errors: [{ message: "Element 'x': not expected" }] }
          : valid(),
    });
    gateway.enqueue('enviarEventos', sifenScenarios.eventosProcesados([ok('2')]));

    const result = await send.execute();

    expect(store.claims).toEqual([{ ids: ['row-2'], dId: 77n }]);
    expect(gateway.callsTo('enviarEventos')[0]?.[0].eventos).toEqual([
      '<gGroupGesEve>2</gGroupGesEve>',
    ]);
    expect(store.rejectedUnsent.get('row-1')).toEqual({
      code: LOCAL_XSD_CODE,
      message: "Element 'x': not expected",
    });
    expect(store.outcomes.has('row-1')).toBe(false);
    expect(result).toEqual({ status: 'sent', approved: 1, rejected: 1, unknown: 0 });
  });

  it('marks a local rejection with a code SIFEN never uses', () => {
    expect(LOCAL_XSD_CODE).toBe('LOC-XSD');
    expect(LOCAL_XSD_CODE.length).toBeLessThanOrEqual(8);
  });

  it('claims and sends nothing when every event fails validation', async () => {
    const { gateway, store, send } = setup([event(1)], {
      validate: () => ({ valid: false, errors: [{ message: 'bad' }] }),
    });

    const result = await send.execute();

    expect(store.claims).toEqual([]);
    expect(gateway.callsTo('enviarEventos')).toEqual([]);
    expect(store.rejectedUnsent.get('row-1')).toEqual({ code: LOCAL_XSD_CODE, message: 'bad' });
    expect(result).toEqual({ status: 'sent', approved: 0, rejected: 1, unknown: 0 });
  });

  it('skips an event whose validation throws: it stays signed, never claimed, and the rest go', async () => {
    const { gateway, store, send } = setup([event(1), event(2)], {
      validate: (xml) => {
        if (xml.includes('>1<')) throw new Error('libxml failed');
        return valid();
      },
    });
    gateway.enqueue('enviarEventos', sifenScenarios.eventosProcesados([ok('2')]));

    const result = await send.execute();

    expect(store.claims[0]?.ids).toEqual(['row-2']);
    expect(store.rejectedUnsent.size).toBe(0);
    expect(result).toEqual({ status: 'sent', approved: 1, rejected: 0, unknown: 0 });
  });

  describe('reading the answer of an event', () => {
    const answer = (dEstRes: string, ...codes: string[]) => ({
      id: '1',
      dEstRes,
      mensajes: codes.map((dCodRes) => ({ dCodRes, dMsgRes: `m${dCodRes}` })),
    });

    it.each([
      ['0600 after another message', answer('Aprobado', '0001', '0600'), 'approved', '0600'],
      [
        'approved with an observation',
        answer('Aprobado con observación', '0600'),
        'approved',
        '0600',
      ],
      [
        '4003, the cancellation SIFEN already holds',
        answer('Rechazado', '4003'),
        'approved',
        '4003',
      ],
      ['4453, the nomination SIFEN already holds', answer('Rechazado', '4453'), 'approved', '4453'],
      ['a refusal with several messages', answer('Rechazado', '4009', '4010'), 'rejected', '4009'],
      ['0600 under a Rechazado state', answer('Rechazado', '0600'), 'unknown', undefined],
      ['an approval without 0600', answer('Aprobado', '4009'), 'unknown', undefined],
      ['an answer without messages', answer('Aprobado'), 'unknown', undefined],
      ['a state it does not know', answer('Pendiente', '0600'), 'unknown', undefined],
    ])('settles %s', async (_name, result, status, code) => {
      const { gateway, store, send } = setup([event(1)]);
      gateway.enqueue('enviarEventos', sifenScenarios.eventosProcesados([result]));

      await send.execute();

      const outcome = store.outcomes.get('row-1');
      expect(outcome?.status).toBe(status);
      if (code) expect(outcome).toMatchObject({ code });
    });

    it('lists the codes that mean SIFEN already holds the effect, provisionally', () => {
      expect([...ALREADY_PROCESSED_CODES]).toEqual(['4003', '4453']);
    });
  });

  describe('when the outcome cannot be recorded', () => {
    function failingRecord(failures: number) {
      const ctx = setup([event(1), event(2)]);
      const warnings: string[] = [];
      let calls = 0;
      const record = ctx.store.record.bind(ctx.store);
      ctx.store.record = (outcomes) => {
        calls += 1;
        return calls <= failures ? Promise.reject(new Error('db down')) : record(outcomes);
      };
      const send = new SendEventBatch({
        gateway: ctx.gateway,
        store: ctx.store,
        nextRequestId: () => Promise.resolve(77n),
        validate: valid,
        logger: { warn: (message) => warnings.push(message) },
      });
      ctx.gateway.enqueue('enviarEventos', sifenScenarios.eventosProcesados([ok('1'), ok('2')]));
      return { ...ctx, send, warnings, calls: () => calls };
    }

    it('retries the record once, logging the event ids, and never sends again', async () => {
      const { gateway, store, send, warnings, calls } = failingRecord(1);

      const result = await send.execute();

      expect(calls()).toBe(2);
      expect(gateway.callsTo('enviarEventos')).toHaveLength(1);
      expect(store.outcomes.size).toBe(2);
      expect(result).toMatchObject({ approved: 2 });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('row-1');
      expect(warnings[0]).toContain('row-2');
    });

    it('rethrows when the retry fails too, leaving the events to the sweep, after logging their ids', async () => {
      const { gateway, store, send, warnings } = failingRecord(2);

      await expect(send.execute()).rejects.toThrow('db down');

      expect(gateway.callsTo('enviarEventos')).toHaveLength(1);
      expect(store.outcomes.size).toBe(0);
      expect(warnings.at(-1)).toMatch(/row-1.*row-2/);
    });
  });

  it('sends only what it claimed when another worker took some events', async () => {
    const { gateway, store, send } = setup([event(1), event(2)], {
      takenByAnother: new Set(['row-1']),
    });
    gateway.enqueue('enviarEventos', sifenScenarios.eventosProcesados([ok('2')]));

    await send.execute();

    expect(gateway.callsTo('enviarEventos')[0]?.[0].eventos).toEqual([
      '<gGroupGesEve>2</gGroupGesEve>',
    ]);
    expect([...store.outcomes.keys()]).toEqual(['row-2']);
  });

  it('does nothing when no event is waiting', async () => {
    const { gateway, store, send } = setup([]);

    expect(await send.execute()).toEqual({ status: 'empty' });
    expect(gateway.callsTo('enviarEventos')).toEqual([]);
    expect(store.claims).toEqual([]);
  });
});
