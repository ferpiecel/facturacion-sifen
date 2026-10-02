import { beforeAll, describe, expect, it } from 'vitest';
import {
  exemptItem,
  signedInvoiceWithQr,
  unnamedReceiver,
} from '../../../../test/support/signed-invoice.js';
import { KudeSourceError, readKudeInvoice } from './kude-reader.js';

let xml: string;
beforeAll(async () => {
  xml = await signedInvoiceWithQr();
});

const without = (source: string, tag: string) =>
  source.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), '');

describe('readKudeInvoice', () => {
  it('maps the signed DE to the KuDE model (MT v150 chapter 13 fields)', () => {
    const model = readKudeInvoice(xml);
    expect(model).toMatchObject({
      environment: 'test',
      cdc: /<DE\b[^>]*\bId="(\d{44})"/.exec(xml)?.[1],
      issuer: {
        name: 'DE generado en ambiente de prueba - sin valor comercial ni fiscal',
        tradeName: 'PoC Offline TIPS',
        activity: 'Desarrollo de Software',
        address: 'Calle Falsa 123',
        city: 'PUERTO PTE.STROESSNER (MUNIC)',
        ruc: '80000001-9',
      },
      stamp: { number: '12345678', validFrom: '2024-01-01' },
      establishment: '001',
      point: '001',
      documentNumber: '0000001',
      issuedAt: '2026-09-30T10:00:00',
      operationCondition: 'Contado',
      currency: 'PYG',
      transactionType: 'Venta de mercadería',
      receiver: {
        kind: 'named',
        document: '80000002-7',
        name: 'Receptor Prueba SA',
        address: 'Avda Prueba 100',
        phone: '061-000000',
        email: 'receptor@test.com',
      },
      totals: {
        subtotalExempt: 0,
        subtotal5: 0,
        subtotal10: 10000,
        totalOperation: 10000,
        totalGs: 10000,
        vat5: 0,
        vat10: 909,
        totalVat: 909,
      },
    });
    expect(model.stamp.validTo).toBeUndefined();
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({
      code: 'A-001',
      unit: 'UNI',
      quantity: 1,
      unitPrice: 10000,
      discount: 0,
      vatRate: 10,
      total: 10000,
    });
  });

  it('takes the VAT liquidation from the XML instead of recomputing it', () => {
    const tampered = xml.replace('<dIVA10>909</dIVA10>', '<dIVA10>123</dIVA10>');
    expect(readKudeInvoice(tampered).totals.vat10).toBe(123);
  });

  it('unescapes the dCarQR text: &amp; becomes &', () => {
    const raw = /<dCarQR>([^<]*)<\/dCarQR>/.exec(xml)?.[1] ?? '';
    expect(raw).toContain('&amp;');
    const { qrUrl } = readKudeInvoice(xml);
    expect(qrUrl).toBe(raw.replaceAll('&amp;', '&'));
    expect(qrUrl).not.toContain('&amp;');
  });

  it('unescapes entities in text fields', () => {
    const escaped = xml.replace(
      'Receptor Prueba SA</dNomRec>',
      'Receptor &amp; Hijos &#xF1; &lt;SA&gt; &#65;</dNomRec>',
    );
    const { receiver } = readKudeInvoice(escaped);
    expect(receiver).toMatchObject({ name: 'Receptor & Hijos ñ <SA> A' });
  });

  it('tolerates namespace prefixes and attributes on the tags', () => {
    const prefixed = xml
      .replace('<dNomRec>', '<s:dNomRec lang="es">')
      .replace('</dNomRec>', '</s:dNomRec>');
    expect(readKudeInvoice(prefixed).receiver).toMatchObject({ name: 'Receptor Prueba SA' });
  });

  it('puts an exempt item in the exempt column', async () => {
    const model = readKudeInvoice(await signedInvoiceWithQr(exemptItem));
    expect(model.items[0]?.vatRate).toBe(0);
    expect(model.totals.subtotalExempt).toBeGreaterThan(0);
  });

  it('reads an unnamed receiver', async () => {
    const model = readKudeInvoice(await signedInvoiceWithQr(unnamedReceiver));
    expect(model.receiver).toEqual({ kind: 'unnamed' });
  });

  it('accepts the stamp end date from the caller (the DE v150 XSD has no dFeFinT)', () => {
    expect(readKudeInvoice(xml, { stampValidTo: '2030-12-31' }).stamp.validTo).toBe('2030-12-31');
  });

  it('reads the production environment from the QR URL', () => {
    const production = xml.replace('/consultas-test/qr?', '/consultas/qr?');
    expect(readKudeInvoice(production).environment).toBe('production');
    const unknown = xml.replace(
      'https://ekuatia.set.gov.py/consultas-test/',
      'https://evil.example/',
    );
    expect(() => readKudeInvoice(unknown)).toThrow(KudeSourceError);
  });

  it.each([
    'dCarQR',
    'dNumTim',
    'dFeIniT',
    'dFeEmiDE',
    'dNomEmi',
    'dDirEmi',
    'dDesCiuEmi',
    'dRucEm',
    'dDVEmi',
    'dNomRec',
    'dTasaIVA',
    'dTotOpeItem',
    'dDesProSer',
    'dTotGralOpe',

    'dDCondOpe',
    'dDesTipTra',
    'cMoneOpe',
  ])('fails closed when %s is missing', (tag) => {
    expect(() => readKudeInvoice(without(xml, tag))).toThrow(new RegExp(tag));
  });

  it('fails closed on a missing CDC, no items, and non-integer PYG amounts', () => {
    expect(() => readKudeInvoice(xml.replace(/ Id="\d{44}"/, ''))).toThrow(/CDC/);
    expect(() => readKudeInvoice(xml.replace(/<gCamItem>[\s\S]*<\/gCamItem>/, ''))).toThrow(/item/);
    expect(() =>
      readKudeInvoice(xml.replace('<dSub10>10000</dSub10>', '<dSub10>1.5</dSub10>')),
    ).toThrow(/dSub10/);
  });

  it('rejects documents that are not an FE', () => {
    expect(() => readKudeInvoice(xml.replace('<iTiDE>1</iTiDE>', '<iTiDE>5</iTiDE>'))).toThrow(
      /unsupported/,
    );
  });

  it('reads each field only from its own group, ignoring look-alike elements elsewhere', () => {
    const decoys =
      '<dFeEmiDE>1999-01-01T00:00:00</dFeEmiDE><dDCondOpe>Decoy</dDCondOpe><cMoneOpe>USD</cMoneOpe>' +
      '<dDesTipTra>Decoy</dDesTipTra><dCuotas>9</dCuotas><dTiCam>9</dTiCam><dCarQR>https://decoy</dCarQR>';
    expect(readKudeInvoice(xml.replace('<gTimb>', `${decoys}<gTimb>`))).toEqual(
      readKudeInvoice(xml),
    );
  });

  it('leaves unknown, inherited and surrogate character references as literal text', () => {
    const odd = xml.replace(
      'Receptor Prueba SA</dNomRec>',
      'A &constructor; &toString; &#xD800; &#55357; B</dNomRec>',
    );
    expect(readKudeInvoice(odd).receiver).toMatchObject({
      name: 'A &constructor; &toString; &#xD800; &#55357; B',
    });
  });

  it('adds the exonerated subtotal to the exempt column', () => {
    const split = xml
      .replace('<dSubExe>0</dSubExe>', '<dSubExe>100</dSubExe>')
      .replace('<dSubExo>0</dSubExo>', '<dSubExo>200</dSubExo>');
    expect(readKudeInvoice(split).totals.subtotalExempt).toBe(300);
  });

  it('rejects foreign currencies explicitly (PYG-only MVP)', () => {
    const usd = xml.replace('<cMoneOpe>PYG</cMoneOpe>', '<cMoneOpe>USD</cMoneOpe>');
    expect(() => readKudeInvoice(usd)).toThrow(/cMoneOpe.*PYG/);
  });
});
