import { describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder } from '@sifen/sifen-tips';
import { context } from '../../../../test/support/invoice-xml-fixture.js';
import { createGeoCatalog } from '../../geo/domain/geo-catalog.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import { generateInvoiceXml, mapInvoiceToXmlInput } from './invoice-xml.js';

/** The AFE draft the signing store builds: the issuer is the receiver, B2C, items without VAT. */
const draft: InvoiceDraft = {
  receiver: { kind: 'named', isPublicEntity: false },
  operationType: 'B2C',
  items: [{ quantity: 2, unitPrice: 50_000, vatRate: 0 }],
  roundingPyg: 0,
  location: {},
};
const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const selfInvoice = {
  seller: { nature: 1, idType: 1, idNumber: '1234567', name: 'Juan Perez', ...place },
  place,
  certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
};
const ctx = () => ({
  ...context('test'),
  selfInvoice,
  receiver: { ruc: '80000001-3', name: 'Empresa Real SA' },
  lines: [context('test').lines[0]],
});

/** Spec: HU-E7-03. The AFE (iTiDE 4) built by xmlgen, checked against the XSD (MT v150 E4, H, 1901, 2101). */
describe('self-invoice XML', () => {
  it('maps type 4 with the seller and the constancia, cash and no FE group', () => {
    const { data } = mapInvoiceToXmlInput(draft, ctx());
    expect(data).toMatchObject({
      tipoDocumento: 4,
      autoFactura: { tipoVendedor: 1, documentoTipo: 1, ubicacion: { departamento: 11 } },
      documentoAsociado: { formato: 3, constanciaTipo: 1, constanciaNumero: '12345678901' },
      condicion: { tipo: 1 },
    });
    expect(data).not.toHaveProperty('factura');
  });

  it('builds an XML that passes the siRecepDE XSD, addressed to the issuer', async () => {
    const { xml, cdc } = await generateInvoiceXml(new TipsDeXmlBuilder(), draft, ctx());
    expect(cdc).toMatch(/^04/);
    expect(xml).toMatch(/<dDesTiDE>Autofactura electrónica<\/dDesTiDE>/);
    expect(xml).toMatch(/<gCamAE><iNatVen>1<\/iNatVen>/);
    expect(xml).toContain('<iTipDocAso>3</iTipDocAso>');
    expect(xml).toContain('<dNumCons>12345678901</dNumCons><dNumControl>ABCD1234</dNumControl>');
    expect(xml).toMatch(/<dRucRec>80000001<\/dRucRec><dDVRec>3<\/dDVRec>/);
    for (const absent of ['<gCamFE>', '<gCamIVA>', '<gTransp>', '<gCamNCDE>']) {
      expect(xml).not.toContain(absent);
    }
  });

  it('writes the DNIT catalog text for both places of the seller', async () => {
    const geoCatalog = createGeoCatalog({
      departments: [{ code: 11, name: 'ALTO PARANA' }],
      districts: [{ code: 143, departmentCode: 11, name: 'DOMINGO MARTINEZ' }],
      cities: [{ code: 3344, districtCode: 143, name: 'PASO ITA CATALOGO' }],
    });
    const { xml } = await generateInvoiceXml(new TipsDeXmlBuilder(), draft, ctx(), { geoCatalog });
    expect(xml).toContain('<dDesCiuVen>PASO ITA CATALOGO</dDesCiuVen>');
    expect(xml).toContain('<dDesDisProv>DOMINGO MARTINEZ</dDesDisProv>');
  });
});
