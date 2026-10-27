import { describe, expect, it } from 'vitest';
import type { IssuerEventBuildInput, ReceiverEvent } from '@sifen/sifen-gateway';
import { TipsEventXmlBuilder } from './event-xml-builder.ts';

const CDC = '01800000019001001000000112026101310000000019';
const receiver = { ruc: '80069563-1', name: 'Distribuidora El Sol S.A.' };
const dates = { issuedAt: '2026-10-13T10:00:00', receivedAt: '2026-10-14T09:30:00' };

const input = (event: ReceiverEvent): IssuerEventBuildInput => ({
  eventId: 77,
  event,
  signedAt: new Date('2026-10-16T12:05:09Z'),
});

/** Spec: HU-E9-01. MT v150 11.5 (GDE, rGeVeConf, rGeVeDisconf, rGeVeDescon, rGeVeNotRec), NT 019 1.1-1.2. */
describe('TipsEventXmlBuilder: receiver events', () => {
  const builder = new TipsEventXmlBuilder();

  it('builds a total conformity as a bare event group with our event id', async () => {
    const xml = await builder.build(
      input({ kind: 'conformity', cdc: CDC, conformityType: 'total' }),
    );

    expect(xml.startsWith('<gGroupGesEve')).toBe(true);
    expect(xml).not.toContain('Envelope');
    expect(xml).toContain('<rEve Id="77">');
    expect(xml).toContain('<dFecFirma>2026-10-16T09:05:09</dFecFirma>');
    expect(xml).toContain(`<rGeVeConf><Id>${CDC}</Id><iTipConf>1</iTipConf></rGeVeConf>`);
  });

  it('a partial conformity carries the estimated receipt date', async () => {
    const xml = await builder.build(
      input({
        kind: 'conformity',
        cdc: CDC,
        conformityType: 'partial',
        estimatedReceiptAt: '2026-10-20T00:00:00',
      }),
    );

    expect(xml).toContain('<iTipConf>2</iTipConf><dFecRecep>2026-10-20T00:00:00</dFecRecep>');
  });

  it('builds a disconformity with the reason', async () => {
    const xml = await builder.build(
      input({ kind: 'disconformity', cdc: CDC, reason: 'Mercadería dañada' }),
    );

    expect(xml).toContain(
      `<rGeVeDisconf><Id>${CDC}</Id><mOtEve>Mercadería dañada</mOtEve></rGeVeDisconf>`,
    );
  });

  it('builds an unawareness with the dates, the receiver as taxpayer and the reason', async () => {
    const xml = await builder.build(
      input({
        kind: 'unawareness',
        cdc: CDC,
        reason: 'No solicité este documento',
        ...dates,
        receiver,
      }),
    );

    expect(xml).toContain(`<rGeVeDescon><Id>${CDC}</Id><dFecEmi>2026-10-13T10:00:00</dFecEmi>`);
    expect(xml).toContain('<dFecRecep>2026-10-14T09:30:00</dFecRecep><iTipRec>1</iTipRec>');
    expect(xml).toContain(
      '<dNomRec>Distribuidora El Sol S.A.</dNomRec><dRucRec>80069563</dRucRec><dDVRec>1</dDVRec>',
    );
    expect(xml).toContain('<mOtEve>No solicité este documento</mOtEve></rGeVeDescon>');
  });

  it('builds a receipt notice with the total in guaraníes', async () => {
    const xml = await builder.build(
      input({ kind: 'receipt_notice', cdc: CDC, totalPyg: 1_500_000, ...dates, receiver }),
    );

    expect(xml).toContain(`<rGeVeNotRec><Id>${CDC}</Id><dFecEmi>2026-10-13T10:00:00</dFecEmi>`);
    expect(xml).toContain('<dTotalGs>1500000</dTotalGs></rGeVeNotRec>');
  });

  it('does not mutate the event it was given', async () => {
    const event: ReceiverEvent = { kind: 'conformity', cdc: CDC, conformityType: 'total' };
    const copy = structuredClone(event);

    await builder.build(input(event));

    expect(event).toEqual(copy);
  });
});
