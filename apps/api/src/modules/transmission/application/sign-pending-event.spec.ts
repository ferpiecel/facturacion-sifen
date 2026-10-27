import { describe, expect, it } from 'vitest';
import type { EventSigner, EventXmlBuilder, IssuerEventBuildInput } from '@sifen/sifen-gateway';
import {
  EventDataIncompleteError,
  EventEnvironmentMismatchError,
  EventIdOutOfRangeError,
  EventKindNotSignableError,
  EventNotFoundError,
  SignPendingEvent,
  type EventSigningStore,
  type EventToSign,
} from './sign-pending-event.js';

const CDC = '01800695631001001000000112026010111234567891';
const NOW = new Date('2026-10-17T12:00:00Z');

const cancellation = (overrides: Partial<EventToSign> = {}): EventToSign => ({
  id: 'ev-1',
  status: 'pending',
  environment: 'test',
  tenantEnvironment: 'test',
  eventId: 7n,
  kind: 'cancellation',
  reason: 'Error en los datos',
  cdc: CDC,
  voidRange: null,
  ...overrides,
});

class InMemoryStore implements EventSigningStore {
  readonly signed = new Map<string, { signedXml: string; signedAt: Date }>();
  constructor(private readonly events: readonly EventToSign[]) {}
  pendingEventIds(limit: number) {
    return Promise.resolve(
      this.events
        .filter((e) => e.status === 'pending')
        .slice(0, limit)
        .map((e) => e.id),
    );
  }
  holdEvent() {
    return Promise.resolve();
  }
  load(id: string) {
    return Promise.resolve(this.events.find((e) => e.id === id));
  }
  markSigned(id: string, signed: { signedXml: string; signedAt: Date }) {
    this.signed.set(id, signed);
    return Promise.resolve(true);
  }
}

function setup(events: readonly EventToSign[], signerFails = false) {
  const built: IssuerEventBuildInput[] = [];
  const signedWith: Buffer[] = [];
  const certificate = { p12: Buffer.from([1, 2, 3]), password: 'pw' };
  const opened: { tenantId: string; environment: string }[] = [];
  const builder: EventXmlBuilder = {
    build: (input) => {
      built.push(input);
      return Promise.resolve(`<gGroupGesEve>${String(input.eventId)}</gGroupGesEve>`);
    },
  };
  const signer: EventSigner = {
    sign: (xml, cert) => {
      if (signerFails) return Promise.reject(new Error('sign failed'));
      signedWith.push(Buffer.from(cert.p12));
      return Promise.resolve(`${xml}<signed/>`);
    },
  };
  const store = new InMemoryStore(events);
  const sign = new SignPendingEvent({
    store,
    certificates: {
      open: (tenantId, environment) => {
        opened.push({ tenantId, environment });
        return Promise.resolve(certificate);
      },
    },
    builder,
    signer,
    now: () => NOW,
  });
  return { store, sign, built, signedWith, certificate, opened };
}

describe('SignPendingEvent', () => {
  it('builds a cancellation from the stored event, signs it with the tenant certificate and stores it', async () => {
    const { store, sign, built, opened } = setup([cancellation()]);

    const result = await sign.execute({ tenantId: 'tenant-1', eventId: 'ev-1' });

    expect(result).toEqual({ status: 'signed' });
    expect(built).toEqual([
      {
        eventId: 7,
        signedAt: NOW,
        event: { kind: 'cancellation', cdc: CDC, reason: 'Error en los datos' },
      },
    ]);
    expect(opened).toEqual([{ tenantId: 'tenant-1', environment: 'test' }]);
    expect(store.signed.get('ev-1')).toEqual({
      signedXml: '<gGroupGesEve>7</gGroupGesEve><signed/>',
      signedAt: NOW,
    });
  });

  it('builds a voiding from its stored range', async () => {
    const range = {
      timbrado: '12345678',
      establishment: '001',
      point: '002',
      from: 3,
      to: 9,
      type: 1,
    };
    const { built, sign } = setup([
      cancellation({ kind: 'voiding', cdc: null, voidRange: { ...range, series: 'AB' } }),
    ]);

    await sign.execute({ tenantId: 't', eventId: 'ev-1' });

    expect(built[0]?.event).toEqual({
      kind: 'voiding',
      timbrado: '12345678',
      establishment: '001',
      expeditionPoint: '002',
      from: 3,
      to: 9,
      documentType: 1,
      reason: 'Error en los datos',
      series: 'AB',
    });
  });

  it('refuses an event id beyond the safe integer range instead of signing with another id', async () => {
    const { sign } = setup([cancellation({ eventId: BigInt(Number.MAX_SAFE_INTEGER) + 1n })]);
    await expect(sign.execute({ tenantId: 't', eventId: 'ev-1' })).rejects.toBeInstanceOf(
      EventIdOutOfRangeError,
    );
  });

  it('zeroizes the certificate however the run ends', async () => {
    const ok = setup([cancellation()]);
    await ok.sign.execute({ tenantId: 't', eventId: 'ev-1' });
    expect([...ok.certificate.p12]).toEqual([0, 0, 0]);

    const failing = setup([cancellation()], true);
    await expect(failing.sign.execute({ tenantId: 't', eventId: 'ev-1' })).rejects.toThrow(
      'sign failed',
    );
    expect([...failing.certificate.p12]).toEqual([0, 0, 0]);
  });

  it('skips an event that is no longer pending', async () => {
    const { store, sign } = setup([cancellation({ status: 'signed' })]);

    expect(await sign.execute({ tenantId: 't', eventId: 'ev-1' })).toEqual({
      status: 'skipped',
      eventStatus: 'signed',
    });
    expect(store.signed.size).toBe(0);
  });

  it('reports an event that was stored by another process in the meantime as skipped', async () => {
    const { store, sign } = setup([cancellation()]);
    store.markSigned = () => Promise.resolve(false);

    expect(await sign.execute({ tenantId: 't', eventId: 'ev-1' })).toEqual({
      status: 'skipped',
      eventStatus: 'signed',
    });
  });

  it.each([
    ['an unknown event', [], EventNotFoundError],
    [
      'an event of another environment than the tenant',
      [cancellation({ tenantEnvironment: 'production' })],
      EventEnvironmentMismatchError,
    ],
    [
      'a nomination, which has no builder yet',
      [cancellation({ kind: 'nomination' })],
      EventKindNotSignableError,
    ],
    [
      'a cancellation without its reason',
      [cancellation({ reason: null })],
      EventDataIncompleteError,
    ],
    [
      'a voiding without its range',
      [cancellation({ kind: 'voiding', cdc: null })],
      EventDataIncompleteError,
    ],
  ])('fails on %s', async (_name, events, error) => {
    const { sign, opened } = setup(events);

    await expect(sign.execute({ tenantId: 't', eventId: 'ev-1' })).rejects.toThrow(error);
    expect(opened).toEqual([]);
  });
});
