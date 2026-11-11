import { describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder } from '@sifen/sifen-tips';
import type { NominationEventReceiver } from '@sifen/sifen-gateway';
import { context } from '../../../../test/support/invoice-xml-fixture.js';
import { nominatedFacts } from '../domain/nominated-receiver.js';
import { generateInvoiceXml } from './invoice-xml.js';

const FE_CDC = '01800000013001001000000112026093010000000019';
const ITEMS = [{ quantity: 1, unitPrice: 55_000, vatRate: 10 as const }];

const TAXPAYER: NominationEventReceiver = {
  kind: 'taxpayer',
  ruc: '80012345-1',
  taxpayerType: 2,
  name: 'Cliente Nominado SA',
  tradeName: 'Nominado',
  country: 'PRY',
  operationType: 'B2B',
  address: 'Avda Nominada',
  houseNumber: '12',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
  phone: '021123456',
  email: 'nominado@test.com',
  customerCode: 'C-9',
};

const PERSON: NominationEventReceiver = {
  kind: 'non-taxpayer',
  documentType: 1,
  documentNumber: '1234567',
  name: 'Maria Gomez',
  country: 'PRY',
  operationType: 'B2C',
};

/**
 * Spec: HU-E8-05 B3c (NT 015). An NCE or NDE over an FE issued to an unnamed receiver is signed
 * with the receiver SIFEN approved in the nomination; the XML must still pass the XSD.
 */
describe('note XML for a nominated receiver', () => {
  const build = (nominated: NominationEventReceiver, note: 'creditNote' | 'debitNote') =>
    generateInvoiceXml(
      new TipsDeXmlBuilder(),
      { ...nominatedFacts(nominated), items: ITEMS, roundingPyg: 0 },
      {
        ...context('test'),
        receiver: { nominated },
        lines: [context('test').lines[0]],
        [note]: { associatedCdc: FE_CDC, reasonCode: 2 },
      },
    );

  it.each(['creditNote', 'debitNote'] as const)(
    'writes a taxpayer by RUC with its contact data in the %s',
    async (note) => {
      const { xml } = await build(TAXPAYER, note);

      expect(xml).toContain('<iNatRec>1</iNatRec>');
      expect(xml).toContain('<dRucRec>80012345</dRucRec><dDVRec>1</dDVRec>');
      expect(xml).toContain('<dNomRec>Cliente Nominado SA</dNomRec>');
      expect(xml).toContain('<dNomFanRec>Nominado</dNomFanRec>');
      expect(xml).toContain('<dDirRec>Avda Nominada</dDirRec>');
      expect(xml).toContain('<dEmailRec>nominado@test.com</dEmailRec>');
      expect(xml).toContain('<dCodCliente>C-9</dCodCliente>');
    },
  );

  it('writes a non-taxpayer by identity document', async () => {
    const { xml } = await build(PERSON, 'creditNote');

    expect(xml).toContain('<iNatRec>2</iNatRec>');
    expect(xml).toContain('<iTipIDRec>1</iTipIDRec>');
    expect(xml).toContain('<dNumIDRec>1234567</dNumIDRec>');
    expect(xml).toContain('<dNomRec>Maria Gomez</dNomRec>');
    expect(xml).not.toContain('<dRucRec>');
  });
});
