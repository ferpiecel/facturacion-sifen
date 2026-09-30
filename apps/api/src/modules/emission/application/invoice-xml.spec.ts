import { describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder } from '@sifen/sifen-tips';
import { createEstablishment } from '../../fiscal-config/domain/establishment.js';
import { DEFAULT_TEST_DOCUMENT_LITERAL } from '../../fiscal-config/domain/document-environment.js';
import { createExpeditionPoint } from '../../fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../../fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../../fiscal-config/domain/ruc.js';
import { createTimbrado } from '../../fiscal-config/domain/timbrado.js';
import { buildCdc } from '../domain/cdc.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import {
  generateInvoiceXml,
  InvoiceXmlError,
  toReceiverXml,
  toSifenXml,
  type InvoiceXmlContext,
} from './invoice-xml.js';

const ruc = parseRuc('80000001-9');

const draft: InvoiceDraft = {
  receiver: { kind: 'named', isPublicEntity: false },
  operationType: 'B2B',
  items: [
    { quantity: 2, unitPrice: 5000, vatRate: 10 },
    { quantity: 1, unitPrice: 1050, vatRate: 5 },
  ],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

function context(environment: 'test' | 'production'): InvoiceXmlContext {
  return {
    environment,
    issuer: createFiscalProfile({
      ruc,
      legalName: 'Empresa Real SA',
      tradeName: 'Empresa Real',
      taxpayerType: 'persona_juridica',
      regimeCode: '8',
      economicActivities: [{ code: '1254', description: 'Desarrollo de Software' }],
    }),
    establishment: createEstablishment({
      code: '001',
      address: 'Calle Falsa',
      houseNumber: '123',
      departmentCode: 11,
      districtCode: '145',
      districtDescription: 'CIUDAD DEL ESTE',
      cityCode: '3432',
      cityDescription: 'PUERTO PTE.STROESSNER (MUNIC)',
    }),
    point: createExpeditionPoint({ code: '001' }),
    timbrado: createTimbrado({ number: '12345678', validityStart: '2024-01-01' }),
    numbering: { documentNumber: '0000001', securityCode: '298398000' },
    issuedAt: '2026-09-30T10:00:00',
    receiver: {
      ruc: '80000002-7',
      name: 'Receptor Prueba SA',
      address: 'Avda Prueba',
      houseNumber: '100',
      districtCode: 143,
      districtDescription: 'DOMINGO MARTINEZ DE IRALA',
      cityCode: 3344,
      cityDescription: 'PASO ITA (INDIGENA)',
    },
    lines: [
      { code: 'A-001', description: 'Servicio real uno', unitCode: 77 },
      { code: 'A-002', description: 'Servicio real dos', unitCode: 77 },
    ],
  };
}

const builder = new TipsDeXmlBuilder();

describe('generateInvoiceXml', () => {
  it('builds XSD-valid XML (siRecepDE) whose DE Id is the CDC of the numbering results', async () => {
    const { xml, cdc } = await generateInvoiceXml(builder, draft, context('production'));

    expect(cdc).toBe(
      buildCdc({
        documentType: '01',
        rucBase: '80000001',
        rucDv: 9,
        establishment: '001',
        point: '001',
        documentNumber: '0000001',
        taxpayerType: 2,
        issueDate: '2026-09-30',
        emissionType: 1,
        securityCode: '298398000',
      }),
    );
    expect(xml).toContain(`<DE Id="${cdc}">`);
  });

  it('keeps the real issuer name and first item in production', async () => {
    const { xml } = await generateInvoiceXml(builder, draft, context('production'));

    expect(xml).toContain('<dNomEmi>Empresa Real SA</dNomEmi>');
    expect(xml).toContain('<dDesProSer>Servicio real uno</dDesProSer>');
  });

  it('applies the mandatory test literal to dNomEmi and the first item only in test', async () => {
    const { xml } = await generateInvoiceXml(builder, draft, context('test'));

    expect(xml).toContain(`<dNomEmi>${DEFAULT_TEST_DOCUMENT_LITERAL}</dNomEmi>`);
    expect(xml).toContain(`<dDesProSer>${DEFAULT_TEST_DOCUMENT_LITERAL}</dDesProSer>`);
    expect(xml).toContain('<dDesProSer>Servicio real dos</dDesProSer>');
  });

  it('follows MT 7.2.4 format rules: no whitespace between tags, padded text, empty tags or negatives', async () => {
    const { xml } = await generateInvoiceXml(builder, draft, context('production'));

    const body = xml.replace(/^<\?xml[^>]*\?>/, '');
    expect(body).not.toMatch(/>\s+</);
    expect(body).not.toMatch(/>\s[^<]*</);
    expect(body).not.toMatch(/>[^<]*\s</);
    expect(body).not.toMatch(/<(\w+)><\/\1>/);
    expect(body).not.toMatch(/>-\d/);
    expect(body).not.toMatch(/<\w+:/);
    expect(body).toMatch(/<dTotOpe>12050<\/dTotOpe>/);
  });

  it('rejects an invalid draft before building anything', async () => {
    const invalid = { ...draft, items: [] };

    await expect(generateInvoiceXml(builder, invalid, context('test'))).rejects.toThrow(
      InvoiceXmlError,
    );
  });

  it('rejects an unnamed receiver, which this mapper does not support yet', async () => {
    const unnamed = { ...draft, receiver: { kind: 'unnamed' } as const };

    await expect(generateInvoiceXml(builder, unnamed, context('test'))).rejects.toThrow(
      /unnamed/,
    );
  });

  it('reports XSD errors other than the not-yet-applied signature', async () => {
    const broken = { buildParaSifen: () => Promise.resolve('<rDE/>') };

    await expect(generateInvoiceXml(broken, draft, context('test'))).rejects.toThrow(
      InvoiceXmlError,
    );
  });
});

describe('SIFEN and receiver variants (rule 2503, J003)', () => {
  const withQr = '<rDE><gCamFuFD><dCarQR>https://q?a=1&amp;b=2</dCarQR></gCamFuFD></rDE>';
  const withInfo =
    '<rDE><gCamFuFD><dCarQR>https://q?a=1&amp;b=2</dCarQR><dInfAdic>Gracias</dInfAdic></gCamFuFD></rDE>';

  it('adds dInfAdic after dCarQR for the receiver', () => {
    expect(toReceiverXml(withQr, 'Gracias')).toBe(withInfo);
  });

  it('escapes the additional information', () => {
    expect(toReceiverXml(withQr, 'A & B <c>')).toContain('<dInfAdic>A &amp; B &lt;c&gt;</dInfAdic>');
  });

  it('strips dInfAdic from the SIFEN version and leaves the rest byte-identical', () => {
    expect(toSifenXml(withInfo)).toBe(withQr);
    expect(toSifenXml(withQr)).toBe(withQr);
  });

  it('refuses to add dInfAdic when the QR block does not exist yet', () => {
    expect(() => toReceiverXml('<rDE/>', 'x')).toThrow(InvoiceXmlError);
  });
});
