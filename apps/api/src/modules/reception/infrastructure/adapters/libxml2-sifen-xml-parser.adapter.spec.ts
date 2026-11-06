import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MalformedSifenXmlError,
  SifenXmlTooLargeError,
  UnsupportedDocumentTypeError,
} from '../../application/ports/sifen-xml-parser.port.js';
import { toReceivedDocumentFields } from '../../application/to-received-document-fields.js';
import { validateTotals } from '../../domain/received-document-validation.js';
import { Libxml2SifenXmlParser } from './libxml2-sifen-xml-parser.adapter.js';

const FIXTURES = fileURLToPath(new URL('../../../../../test/fixtures/reception/', import.meta.url));

function fixture(path: string): string {
  return readFileSync(`${FIXTURES}${path}/documento.xml`, 'utf8');
}

const contado = fixture('sifen/factura_contado');
const servicioDigital = fixture('sifen/factura_servicio_digital');
const parser = new Libxml2SifenXmlParser();

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('Libxml2SifenXmlParser goldens', () => {
  it('parses factura_contado header, totals and items', () => {
    const doc = parser.parse(contado);
    expect(doc.cdc).toBe('00000000000000000000000000000000000000000001');
    expect(doc.documentType).toBe(1);
    expect(doc.issuer).toEqual({
      ruc: '80000000',
      dv: '3',
      legalName: 'EMPRESA ANONIMIZADA S.A.',
    });
    expect(doc.receiver).toEqual({
      ruc: '80000001',
      dv: '8',
      name: 'CONSUMIDOR FINAL ANONIMIZADO',
    });
    expect([doc.establishment, doc.expeditionPoint, doc.number]).toEqual(['002', '001', '0014228']);
    expect(doc.documentNumber).toBe('002-001-0014228');
    expect(doc.issueDate).toBe('2026-01-27');
    expect(doc.currency).toBe('PYG');
    expect(doc.paymentCondition).toBe('cash');
    expect(doc.creditTermDays).toBeNull();
    expect(doc.authorizationProtocol).toBe('2937837504');
    expect(doc.totals).toEqual({
      exempt: '0',
      exonerated: '0',
      taxable5: '0',
      taxable10: '185454.54545455',
      vat5: '0',
      vat10: '18545.45454545',
      total: '204000',
    });
    expect(doc.items).toHaveLength(7);
    expect(doc.items[0]).toEqual({
      description: 'PARA ACA',
      quantity: '1',
      unitPrice: '0',
      discount: '0',
      taxRate: 0,
      taxBase: '0',
      taxAmount: '0',
      lineTotal: '0',
    });
    expect(doc.items[1]).toEqual({
      description: 'Mbeju Roquefort',
      quantity: '1',
      unitPrice: '28000',
      discount: '0',
      taxRate: 10,
      taxBase: '25454.54545455',
      taxAmount: '2545.45454545',
      lineTotal: '28000',
    });
  });

  it('parses factura_servicio_digital (receiver without RUC)', () => {
    const doc = parser.parse(servicioDigital);
    expect(doc.cdc).toBe('00000000000000000000000000000000000000000003');
    expect(doc.issuer.ruc).toBe('80000003');
    expect(doc.issuer.dv).toBe('8');
    expect(doc.receiver).toEqual({ ruc: null, dv: null, name: 'CONSUMIDOR FINAL ANONIMIZADO' });
    expect(doc.documentNumber).toBe('001-007-0019682');
    expect(doc.issueDate).toBe('2025-05-03');
    expect(doc.totals.taxable10).toBe('68182');
    expect(doc.totals.vat10).toBe('6818');
    expect(doc.totals.total).toBe('75000.00000000');
    expect(doc.items).toEqual([
      {
        description: 'PPV Tigo Sports',
        quantity: '1',
        unitPrice: '75000',
        discount: '0',
        taxRate: 10,
        taxBase: '68182',
        taxAmount: '6818',
        lineTotal: '75000',
      },
    ]);
    expect(doc.authorizationProtocol).toBe('2292919203');
  });

  it('parses the ekuatia captures: success, success_pago_credito, servicio_digital', () => {
    expect(parser.parse(fixture('ekuatia/v2026-Q3/success')).totals.total).toBe('204000');
    expect(parser.parse(fixture('ekuatia/v2026-Q3/servicio_digital')).totals.total).toBe(
      '75000.00000000',
    );
    const credito = parser.parse(fixture('ekuatia/v2026-Q3/success_pago_credito'));
    expect(credito.cdc).toBe('00000000000000000000000000000000000000000002');
    expect(credito.documentNumber).toBe('001-001-3546023');
    expect(credito.issueDate).toBe('2026-08-04');
    expect(credito.issuer.ruc).toBe('80000002');
    expect(credito.issuer.dv).toBe('4');
    expect(credito.totals.exempt).toBe('126533');
    expect(credito.totals.total).toBe('126533');
    expect(credito.items.map((item) => item.lineTotal)).toEqual(['124170', '2363']);
  });

  it('accepts bytes as well as strings', () => {
    expect(parser.parse(new TextEncoder().encode(contado)).cdc).toBe(parser.parse(contado).cdc);
  });

  it('parse output satisfies the R3.1 totals validation on every golden', () => {
    for (const path of [
      'sifen/factura_contado',
      'sifen/factura_servicio_digital',
      'ekuatia/v2026-Q3/success',
      'ekuatia/v2026-Q3/success_pago_credito',
      'ekuatia/v2026-Q3/servicio_digital',
    ]) {
      const fields = toReceivedDocumentFields(parser.parse(fixture(path)));
      if (fields.totals === null) throw new Error('totals missing');
      expect(validateTotals(fields.totals, fields.itemAmounts), path).toEqual([]);
    }
    const fields = toReceivedDocumentFields(parser.parse(contado));
    expect(fields.issuerRuc).toBe('80000000-3');
    expect(fields.documentNumber).toBe('002-001-0014228');
  });
});

describe('Libxml2SifenXmlParser shapes and fields', () => {
  it('handles rDE without namespace', () => {
    const plain = contado.replace(/ xmlns="[^"]*"/, '');
    expect(plain).not.toContain('xmlns="');
    expect(parser.parse(plain).documentNumber).toBe('002-001-0014228');
  });

  it('handles rDE wrapped in an envelope element', () => {
    const wrapped = `<?xml version="1.0" encoding="UTF-8"?><rEnviDe><xDE>${contado}</xDE></rEnviDe>`;
    expect(parser.parse(wrapped).cdc).toBe('00000000000000000000000000000000000000000001');
  });

  it('accepts a UTF-8 byte order mark and non-ASCII text', () => {
    const bytes = new TextEncoder().encode(`\uFEFF${contado}`);
    expect(parser.parse(bytes).items.some((item) => item.description.includes('piña'))).toBe(true);
  });

  it('reads credit condition and term', () => {
    const credit = contado
      .replace(
        '<iCondOpe>1</iCondOpe><dDCondOpe>Contado</dDCondOpe>',
        '<iCondOpe>2</iCondOpe><dDCondOpe>Crédito</dDCondOpe>',
      )
      .replace(
        '</gPaConEIni></gCamCond>',
        '</gPaConEIni><gPagCred><iCondCred>1</iCondCred><dPlazoCre>30 días</dPlazoCre></gPagCred></gCamCond>',
      );
    const doc = parser.parse(credit);
    expect(doc.paymentCondition).toBe('credit');
    expect(doc.creditTermDays).toBe(30);
  });

  it('reads an item discount', () => {
    const discounted = contado.replace(
      '<dDescItem>0</dDescItem>',
      '<dDescItem>1500.50</dDescItem>',
    );
    expect(parser.parse(discounted).items[0]?.discount).toBe('1500.50');
  });

  it('rejects an unknown payment condition and invalid money', () => {
    const odd = contado.replace('<iCondOpe>1</iCondOpe>', '<iCondOpe>9</iCondOpe>');
    expect(capture(() => parser.parse(odd))).toMatchObject({ code: 'invalid_value' });
    const money = contado.replace(
      '<dTotGralOpe>204000</dTotGralOpe>',
      '<dTotGralOpe>2e5</dTotGralOpe>',
    );
    expect(capture(() => parser.parse(money))).toMatchObject({ code: 'invalid_value' });
  });

  it('rejects a document without items or without totals', () => {
    const noItems = contado.replace(/<gCamItem>.*<\/gCamItem>/, '');
    expect(capture(() => parser.parse(noItems))).toMatchObject({ code: 'missing_element' });
    const noTotals = contado.replace(/<gTotSub>.*<\/gTotSub>/, '');
    expect(capture(() => parser.parse(noTotals))).toMatchObject({ code: 'missing_element' });
  });
});

describe('Libxml2SifenXmlParser rejections', () => {
  it('rejects an unsupported iTiDE with a typed error', () => {
    const credit = contado.replace('<iTiDE>1</iTiDE>', '<iTiDE>5</iTiDE>');
    const error = capture(() => parser.parse(credit));
    expect(error).toBeInstanceOf(UnsupportedDocumentTypeError);
    expect((error as UnsupportedDocumentTypeError).documentType).toBe(5);
  });

  it('rejects malformed XML', () => {
    for (const bad of ['<rDE><DE>', '', 'not xml', '<a/>']) {
      expect(
        capture(() => parser.parse(bad)),
        bad,
      ).toBeInstanceOf(MalformedSifenXmlError);
    }
  });

  it('rejects an external-entity (XXE) document without reading the file', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE rDE [<!ENTITY x SYSTEM "file:///etc/passwd">]>${contado.replace('<dVerFor>150', '<dVerFor>&x;')}`;
    const error = capture(() => parser.parse(xxe));
    expect(error).toBeInstanceOf(MalformedSifenXmlError);
    expect(error).toMatchObject({ code: 'dtd_forbidden' });
    expect((error as Error).message).not.toContain('passwd');
  });

  it('rejects a billion-laughs document', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><rDE>&lol3;</rDE>`;
    expect(capture(() => parser.parse(laughs))).toMatchObject({ code: 'dtd_forbidden' });
  });

  it('rejects DOCTYPE and ENTITY regardless of case, whitespace tricks or an internal-only subset', () => {
    expect(capture(() => parser.parse(`<!DOCTYPE rDE>${contado}`))).toMatchObject({
      code: 'dtd_forbidden',
    });
    expect(capture(() => parser.parse(`<!DOCTYPE\n rDE>${contado}`))).toMatchObject({
      code: 'dtd_forbidden',
    });
  });

  it('rejects UTF-16 input (cannot be scanned for a DTD)', () => {
    const utf16 = Buffer.from(`\uFEFF${contado}`, 'utf16le');
    expect(capture(() => parser.parse(utf16))).toMatchObject({ code: 'unsupported_encoding' });
  });

  it('rejects documents over the byte limit before parsing', () => {
    const small = new Libxml2SifenXmlParser({ maxBytes: 1000 });
    const error = capture(() => small.parse(contado));
    expect(error).toBeInstanceOf(SifenXmlTooLargeError);
    expect(error).toMatchObject({ maxBytes: 1000 });
    expect(capture(() => small.parse(new Uint8Array(1001)))).toBeInstanceOf(SifenXmlTooLargeError);
  });

  it('measures strings in UTF-8 bytes and defaults to 2 MiB', () => {
    const tight = new Libxml2SifenXmlParser({ maxBytes: 20 });
    expect(capture(() => tight.parse('ñ'.repeat(11)))).toBeInstanceOf(SifenXmlTooLargeError);
    const huge = new Uint8Array(2 * 1024 * 1024 + 1);
    expect(capture(() => parser.parse(huge))).toBeInstanceOf(SifenXmlTooLargeError);
  });

  it('rejects invalid constructor options', () => {
    expect(() => new Libxml2SifenXmlParser({ maxBytes: 0 })).toThrow();
  });
});
