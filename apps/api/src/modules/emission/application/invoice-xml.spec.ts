import { describe, expect, it } from 'vitest';
import { validateXml } from '@sifen/sifen-xsd';
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
  mapInvoiceToXmlInput,
  toReceiverXml,
  toSifenXml,
  type InvoiceXmlContext,
} from './invoice-xml.js';

const ruc = parseRuc('80000001-3');

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
    establishmentContact: { phone: '0973-000000', email: 'emisor@test.com', name: 'Casa Matriz' },
    point: createExpeditionPoint({ code: '001' }),
    timbrado: createTimbrado({ number: '12345678', validityStart: '2024-01-01' }),
    numbering: { documentNumber: '0000001', securityCode: '298398000' },
    issuedAt: new Date('2026-09-30T13:00:00Z'),
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

const MISSING_SIGNATURE =
  "Element '{http://ekuatia.set.gov.py/sifen/xsd}rDE': Missing child element(s). Expected is ( {http://www.w3.org/2000/09/xmldsig#}Signature ).";

describe('generateInvoiceXml', () => {
  it('builds XSD-valid XML (siRecepDE) whose DE Id is the CDC of the numbering results', async () => {
    const { xml, cdc } = await generateInvoiceXml(builder, draft, context('production'));

    expect(cdc).toBe(
      buildCdc({
        documentType: '01',
        rucBase: '80000001',
        rucDv: 3,
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
    expect(body).toMatch(/<dTotOpe>11050<\/dTotOpe>/);
  });

  it('before signing, the XSD reports exactly one error: the missing ds:Signature', async () => {
    const { xml } = await generateInvoiceXml(builder, draft, context('production'));

    const { errors } = validateXml(xml, 'siRecepDE');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(MISSING_SIGNATURE);
    expect(errors[0]?.path).toBe('/*');
  });

  it('does not tolerate another XSD error that merely mentions Signature', async () => {
    const real = await generateInvoiceXml(builder, draft, context('production'));
    const bogus = real.xml.replace(
      '</rDE>',
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/></rDE>',
    );

    await expect(
      generateInvoiceXml({ buildParaSifen: () => Promise.resolve(bogus) }, draft, context('test')),
    ).rejects.toThrow(InvoiceXmlError);
  });

  it('does not tolerate a content error next to the missing signature', async () => {
    const real = await generateInvoiceXml(builder, draft, context('production'));
    const bad = real.xml.replace('<dVerFor>150</dVerFor>', '<dVerFor>151</dVerFor>');

    await expect(
      generateInvoiceXml({ buildParaSifen: () => Promise.resolve(bad) }, draft, context('test')),
    ).rejects.toThrow(/dVerFor/);
  });

  it('derives the emission date and dFeEmiDE in America/Asuncion, not UTC', async () => {
    const ctx = { ...context('production'), issuedAt: new Date('2026-10-01T01:30:00Z') };

    const { xml, cdc } = await generateInvoiceXml(builder, draft, ctx);

    expect(xml).toContain('<dFeEmiDE>2026-09-30T22:30:00</dFeEmiDE>');
    expect(cdc.slice(25, 33)).toBe('20260930');
  });

  it('anchors the Id check to the root DE, not to any text containing the CDC', async () => {
    const real = await generateInvoiceXml(builder, draft, context('production'));
    const forged = real.xml
      .replace(`<DE Id="${real.cdc}">`, '<DE Id="99999999999999999999999999999999999999999999">')
      .replace('</DE>', `</DE><!--<DE Id="${real.cdc}">-->`);

    await expect(
      generateInvoiceXml({ buildParaSifen: () => Promise.resolve(forged) }, draft, context('test')),
    ).rejects.toThrow(/Id/);
  });

  it.each([
    ['B2B', 1],
    ['B2C', 2],
    ['B2G', 3],
    ['B2F', 4],
  ] as const)('maps operation type %s to iTiOpe %i', (operationType, code) => {
    const { data } = mapInvoiceToXmlInput({ ...draft, operationType }, context('test'));

    expect((data.cliente as { tipoOperacion: number }).tipoOperacion).toBe(code);
  });

  it('omits the optional trade name and regime when the profile has none', async () => {
    const base = context('production');
    const issuer = createFiscalProfile({
      ruc,
      legalName: 'Empresa Real SA',
      taxpayerType: 'persona_juridica',
      economicActivities: [{ code: '1254', description: 'Desarrollo de Software' }],
    });

    const { xml } = await generateInvoiceXml(builder, draft, { ...base, issuer });

    expect(xml).not.toContain('<dNomFanEmi>');
    expect(xml).not.toContain('<cTipReg>');
  });

  it('maps VAT 0 as exempt and VAT 5 as 5%, with integer PYG amounts', async () => {
    const mixed = {
      ...draft,
      items: [
        { quantity: 1.5, unitPrice: 1000, vatRate: 0 as const },
        { quantity: 1, unitPrice: 2100, vatRate: 5 as const },
      ],
    };

    const { xml } = await generateInvoiceXml(builder, mixed, context('production'));

    expect(xml).toContain('<dDesAfecIVA>Exento</dDesAfecIVA>');
    expect(xml).toContain('<dTasaIVA>5</dTasaIVA>');
    expect(xml).toContain('<dTotOpe>3600</dTotOpe>');
  });

  it('rejects a fractional PYG line total (non-integer quantity x price)', async () => {
    const fractional = {
      ...draft,
      items: [{ quantity: 1.5, unitPrice: 1001, vatRate: 10 as const }],
    };

    await expect(generateInvoiceXml(builder, fractional, context('test'))).rejects.toThrow(
      /pyg-integer/,
    );
  });

  it('rejects an invalid draft before building anything', async () => {
    const invalid = { ...draft, items: [] };

    await expect(generateInvoiceXml(builder, invalid, context('test'))).rejects.toThrow(
      InvoiceXmlError,
    );
  });

  it('rejects an unnamed receiver, which this mapper does not support yet', async () => {
    const unnamed = { ...draft, receiver: { kind: 'unnamed' } as const };

    await expect(generateInvoiceXml(builder, unnamed, context('test'))).rejects.toThrow(/unnamed/);
  });

  it('reports XSD errors other than the not-yet-applied signature', async () => {
    const broken = { buildParaSifen: () => Promise.resolve('<rDE/>') };

    await expect(generateInvoiceXml(broken, draft, context('test'))).rejects.toThrow(
      InvoiceXmlError,
    );
  });
});

describe('SIFEN and receiver variants (rule 2503, J003)', () => {
  const qr = '<dCarQR>https://q?a=1&amp;b=2</dCarQR>';
  const signed = '<DE Id="x"><gCamItem><dInfAdic>item note</dInfAdic></gCamItem></DE><Signature/>';
  const withQr = `<rDE>${signed}<gCamFuFD>${qr}</gCamFuFD></rDE>`;
  const withInfo = `<rDE>${signed}<gCamFuFD>${qr}<dInfAdic>Gracias</dInfAdic></gCamFuFD></rDE>`;

  it('adds dInfAdic after dCarQR inside gCamFuFD for the receiver', () => {
    expect(toReceiverXml(withQr, 'Gracias')).toBe(withInfo);
  });

  it('replaces an existing gCamFuFD dInfAdic, including self-closing and attributed forms', () => {
    const selfClosing = withQr.replace('</gCamFuFD>', '<dInfAdic/></gCamFuFD>');
    const attributed = withQr.replace('</gCamFuFD>', '<dInfAdic a="1">Viejo</dInfAdic></gCamFuFD>');

    expect(toReceiverXml(selfClosing, 'Gracias')).toBe(withInfo);
    expect(toReceiverXml(attributed, 'Gracias')).toBe(withInfo);
  });

  it('escapes markup and quotes, and drops XML-illegal control characters', () => {
    const xml = toReceiverXml(withQr, 'A & B <c> "d" \'e\'\u0001\u000B');

    expect(xml).toContain('<dInfAdic>A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;</dInfAdic>');
  });

  it('strips only the gCamFuFD dInfAdic and leaves an item-level one untouched', () => {
    expect(toSifenXml(withInfo)).toBe(withQr);
    expect(toSifenXml(withQr)).toBe(withQr);
    expect(toSifenXml(withInfo)).toContain('<dInfAdic>item note</dInfAdic>');
  });

  it('refuses to add dInfAdic when the QR block does not exist yet', () => {
    expect(() => toReceiverXml('<rDE/>', 'x')).toThrow(InvoiceXmlError);
    expect(() => toReceiverXml('<rDE><dCarQR>q</dCarQR></rDE>', 'x')).toThrow(InvoiceXmlError);
  });
});
