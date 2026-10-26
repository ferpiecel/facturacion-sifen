import { describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder } from '@sifen/sifen-tips';
import { context } from '../../../../test/support/invoice-xml-fixture.js';
import { createGeoCatalog } from '../../geo/domain/geo-catalog.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import type { RemissionDraft } from '../domain/remission-draft.js';
import { generateInvoiceXml, mapInvoiceToXmlInput } from './invoice-xml.js';

/** The draft the signing store builds for an NRE: the receiver is named, the items carry no price. */
const draft: InvoiceDraft = {
  receiver: {
    kind: 'named',
    isPublicEntity: false,
    address: { street: 'Calle 1', houseNumber: '10', districtCode: 143, cityCode: 3344 },
  },
  operationType: 'B2B',
  items: [{ quantity: 2, unitPrice: 0, vatRate: 0 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};
const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const transport: RemissionDraft['transport'] = {
  type: 1,
  modality: 1,
  freightResponsible: 1,
  startDate: '2026-11-02',
  endDate: '2026-11-03',
  departure: place,
  delivery: { ...place, address: 'Calle 2' },
  vehicle: { type: 'Camion', brand: 'Volvo', idType: 1, idNumber: 'ABC123' },
  carrier: {
    contributor: true,
    name: 'Transportes SA',
    ruc: '80000002-1',
    address: 'Ruta 1',
    driver: { name: 'Pedro Gomez', idNumber: '2345678', address: 'Calle 3' },
  },
};
const remission = { motive: 1, responsible: 1, km: 120, invoiceDate: '2026-11-01', transport };
const ctx = () => ({
  ...context('test'),
  remission,
  receiver: {
    ruc: '80000001-3',
    name: 'Empresa Real SA',
    address: 'Calle 1',
    houseNumber: '10',
    districtCode: 143,
    cityCode: 3344,
  },
  lines: [context('test').lines[0]],
});

/** Spec: HU-E7-04. The NRE (iTiDE 7) built by xmlgen, checked against the XSD (MT v150 E5, E10). */
describe('remission note XML', () => {
  it('maps type 7 with the remission and the transport, no condition and no FE group', () => {
    const { data } = mapInvoiceToXmlInput(draft, ctx());
    expect(data).toMatchObject({
      tipoDocumento: 7,
      remision: { motivo: 1, tipoResponsable: 1, kms: 120, fechaFactura: '2026-11-01' },
      detalleTransporte: {
        tipo: 1,
        modalidad: 1,
        tipoResponsable: 1,
        inicioEstimadoTranslado: '2026-11-02',
        salida: { direccion: 'Calle 1', departamento: 11 },
        entrega: { direccion: 'Calle 2' },
        vehiculo: { tipo: 'Camion', marca: 'Volvo', documentoTipo: 1, documentoNumero: 'ABC123' },
        transportista: {
          contribuyente: true,
          ruc: '80000002-1',
          chofer: { nombre: 'Pedro Gomez' },
        },
      },
    });
    expect(data).not.toHaveProperty('condicion');
    expect(data).not.toHaveProperty('factura');
  });

  it('builds an XML that passes the siRecepDE XSD, addressed to the receiver', async () => {
    const { xml, cdc } = await generateInvoiceXml(new TipsDeXmlBuilder(), draft, ctx());
    expect(cdc).toMatch(/^07/);
    expect(xml).toMatch(/<dDesTiDE>Nota de remisión electrónica<\/dDesTiDE>/);
    expect(xml).toContain('<iMotEmiNR>1</iMotEmiNR>');
    expect(xml).toContain('<dKmR>120</dKmR>');
    expect(xml).toMatch(/<gTransp>/);
    expect(xml).toMatch(/<dRucRec>80000001<\/dRucRec><dDVRec>3<\/dDVRec>/);
    for (const absent of ['<gCamFE>', '<gCamCond>', '<gCamIVA>', '<gTotSub>', '<gValorItem>']) {
      expect(xml).not.toContain(absent);
    }
  });

  it('writes the DNIT catalog text for the departure and the delivery', async () => {
    const geoCatalog = createGeoCatalog({
      departments: [{ code: 11, name: 'ALTO PARANA' }],
      districts: [{ code: 143, departmentCode: 11, name: 'DOMINGO MARTINEZ' }],
      cities: [{ code: 3344, districtCode: 143, name: 'PASO ITA CATALOGO' }],
    });
    const { xml } = await generateInvoiceXml(new TipsDeXmlBuilder(), draft, ctx(), { geoCatalog });
    expect(xml).toContain('<dDesCiuSal>PASO ITA CATALOGO</dDesCiuSal>');
    expect(xml).toContain('<dDesCiuEnt>PASO ITA CATALOGO</dDesCiuEnt>');
    expect(xml).toContain('<dDesDisSal>DOMINGO MARTINEZ</dDesDisSal>');
  });
});
