import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import { DuplicateEventIdError } from '../domain/event-batch.js';
import {
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

  it('rejects locally an event that does not validate against the XSD, and sends the others', async () => {
    const { gateway, store, send } = setup([event(1), event(2)], {
      validate: (xml) =>
        xml.includes('>1<')
          ? { valid: false, errors: [{ message: "Element 'x': not expected" }] }
          : valid(),
    });
    gateway.enqueue('enviarEventos', sifenScenarios.eventosProcesados([ok('2')]));

    const result = await send.execute();

    expect(gateway.callsTo('enviarEventos')[0]?.[0].eventos).toEqual([
      '<gGroupGesEve>2</gGroupGesEve>',
    ]);
    expect(store.outcomes.get('row-1')).toEqual({
      status: 'rejected',
      code: 'XSD',
      message: "Element 'x': not expected",
    });
    expect(result).toEqual({ status: 'sent', approved: 1, rejected: 1, unknown: 0 });
  });

  it('does not call SIFEN when every event fails validation', async () => {
    const { gateway, store, send } = setup([event(1)], {
      validate: () => ({ valid: false, errors: [{ message: 'bad' }] }),
    });

    await send.execute();

    expect(gateway.callsTo('enviarEventos')).toEqual([]);
    expect(store.outcomes.get('row-1')).toMatchObject({ status: 'rejected', code: 'XSD' });
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
