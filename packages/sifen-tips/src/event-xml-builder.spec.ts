import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssuerEventBuildInput } from '@sifen/sifen-gateway';
import { TipsEventXmlBuilder } from './event-xml-builder.ts';

const CDC = '01800000019001001000000112026101310000000019';

const cancellation = (overrides: Partial<IssuerEventBuildInput> = {}): IssuerEventBuildInput => ({
  eventId: 42,
  event: { kind: 'cancellation', cdc: CDC, reason: 'Error en los datos del receptor' },
  ...overrides,
});

const voiding = (): IssuerEventBuildInput => ({
  eventId: 43,
  event: {
    kind: 'voiding',
    timbrado: '12345678',
    establishment: '001',
    expeditionPoint: '002',
    from: 1,
    to: 25,
    documentType: 1,
    reason: 'Numeros que no se usaron',
  },
});

const voidingRange = (from: number, to: number): IssuerEventBuildInput => {
  const base = voiding();
  return {
    ...base,
    event: { ...(base.event as Extract<typeof base.event, { kind: 'voiding' }>), from, to },
  };
};

describe('TipsEventXmlBuilder', () => {
  const builder = new TipsEventXmlBuilder();

  it('returns the bare event group, without the SOAP envelope or the XML declaration', async () => {
    const xml = await builder.build(cancellation());

    expect(xml.startsWith('<gGroupGesEve')).toBe(true);
    expect(xml.endsWith('</gGroupGesEve>')).toBe(true);
    expect(xml).not.toContain('Envelope');
    expect(xml).not.toContain('<?xml');
    expect(xml).not.toContain('rEnviEventoDe');
  });

  it('builds a cancellation with the CDC, the reason and our event id', async () => {
    const xml = await builder.build(cancellation());

    expect(xml).toContain('<rEve Id="42">');
    expect(xml).toContain('<dVerFor>150</dVerFor>');
    expect(xml).toMatch(/<dFecFirma>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}<\/dFecFirma>/);
    expect(xml).toContain(
      `<rGeVeCan><Id>${CDC}</Id><mOtEve>Error en los datos del receptor</mOtEve></rGeVeCan>`,
    );
  });

  it('builds a voiding with the numbers padded to 7 digits', async () => {
    const xml = await builder.build(voiding());

    expect(xml).toContain('<rEve Id="43">');
    expect(xml).toContain(
      '<rGeVeInu><dNumTim>12345678</dNumTim><dEst>001</dEst><dPunExp>002</dPunExp>' +
        '<dNumIn>0000001</dNumIn><dNumFin>0000025</dNumFin><iTiDE>1</iTiDE>' +
        '<mOtEve>Numeros que no se usaron</mOtEve></rGeVeInu>',
    );
    expect(xml).not.toContain('dSerieNum');
  });

  it('carries the series of a voiding when there is one', async () => {
    const input = voiding();
    const withSeries: IssuerEventBuildInput = {
      ...input,
      event: { ...(input.event as Extract<typeof input.event, { kind: 'voiding' }>), series: 'AB' },
    };

    expect(await builder.build(withSeries)).toContain('<dSerieNum>AB</dSerieNum>');
  });

  describe('the signing instant (dFecFirma) is Asunción wall-clock time, whatever the host zone', () => {
    const original = process.env.TZ;
    afterEach(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it.each(['UTC', 'America/Asuncion', 'Asia/Tokyo', 'America/New_York'])(
      'with TZ=%s',
      async (zone) => {
        process.env.TZ = zone;

        const xml = await builder.build(
          cancellation({ signedAt: new Date('2026-10-16T12:05:09Z') }),
        );

        // Paraguay has been on UTC-3 all year since October 2024.
        expect(xml).toContain('<dFecFirma>2026-10-16T09:05:09</dFecFirma>');
      },
    );

    it('is UTC-3 in July too, as Paraguay has no daylight saving time since October 2024', async () => {
      // A host with tzdata older than 2024b would answer 08:05:09 (UTC-4 in the southern winter).
      process.env.TZ = 'UTC';

      const xml = await builder.build(cancellation({ signedAt: new Date('2026-07-16T12:05:09Z') }));

      expect(xml).toContain('<dFecFirma>2026-07-16T09:05:09</dFecFirma>');
    });

    it('crosses midnight with the right date', async () => {
      process.env.TZ = 'UTC';

      const xml = await builder.build(cancellation({ signedAt: new Date('2026-10-17T01:30:00Z') }));

      expect(xml).toContain('<dFecFirma>2026-10-16T22:30:00</dFecFirma>');
    });

    it('uses the current time in Asunción when no instant is given', async () => {
      process.env.TZ = 'UTC';
      vi.useFakeTimers({ now: new Date('2026-10-16T03:00:00Z') });
      try {
        expect(await builder.build(cancellation())).toContain(
          '<dFecFirma>2026-10-16T00:00:00</dFecFirma>',
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('refuses a voiding whose end is not after its start (4068)', async () => {
    for (const [from, to] of [
      [5, 5],
      [6, 5],
    ] as const) {
      await expect(builder.build(voidingRange(from, to))).rejects.toThrow(RangeError);
    }
  });

  it('refuses a voiding of more than 1000 numbers (4067) and accepts exactly 1000', async () => {
    await expect(builder.build(voidingRange(1, 1001))).rejects.toThrow(RangeError);
    await expect(builder.build(voidingRange(1, 1000))).resolves.toContain(
      '<dNumFin>0001000</dNumFin>',
    );
  });

  it.each([0, -1, 1.5, 10_000_000_000, Number.NaN])('refuses the event id %s', async (eventId) => {
    await expect(builder.build(cancellation({ eventId }))).rejects.toThrow(RangeError);
  });

  it('lets the library refuse a reason shorter than 5 characters', async () => {
    await expect(
      builder.build({ eventId: 1, event: { kind: 'cancellation', cdc: CDC, reason: 'no' } }),
    ).rejects.toThrow(/Motivo/);
  });

  it('does not touch the input it is given', async () => {
    const input = cancellation();
    const copy = structuredClone(input);

    await builder.build(input);

    expect(input).toEqual(copy);
  });
});
