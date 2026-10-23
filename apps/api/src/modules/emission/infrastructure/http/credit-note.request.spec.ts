import { describe, expect, it } from 'vitest';
import { parseCreateDocument } from './create-document.request.js';
import {
  parseCreateCreditNote,
  parseCreateDebitNote,
  parseDocumentRequest,
  toCreditNoteDraft,
} from './credit-note.request.js';

const FE_CDC = '01800695631001001000000112026010111234567891';
const ITEM = {
  code: 'A-001',
  description: 'Devolucion de servicio',
  unitCode: 77,
  quantity: 1,
  unitPrice: 400_000,
  vatRate: 10,
};
const NCE = {
  type: 'NCE',
  establishment: '001',
  expeditionPoint: '002',
  associatedCdc: FE_CDC,
  reasonCode: 2,
  items: [ITEM],
  roundingPyg: 0,
};
const FE = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: { kind: 'named', ruc: '80069563-1', name: 'Cliente SA' },
  items: [ITEM],
};

const errorsOf = (body: unknown) => {
  const result = parseCreateCreditNote(body);
  return result.ok ? [] : result.errors.map((e) => `${e.field}:${e.rule}`);
};

/** Spec: HU-E7-01 (ADR-0019 D1, D2, D3). The NCE body has no receiver: it is the FE's. */
describe('parseCreateCreditNote', () => {
  it('accepts a credit note and defaults the rounding and currency', () => {
    const withoutRounding = Object.fromEntries(
      Object.entries(NCE).filter(([key]) => key !== 'roundingPyg'),
    );
    const result = parseCreateCreditNote(withoutRounding);
    expect(result.ok && result.value).toMatchObject({
      type: 'NCE',
      associatedCdc: FE_CDC,
      reasonCode: 2,
      roundingPyg: 0,
      currency: 'PYG',
    });
  });

  it.each([
    ['a short CDC', { associatedCdc: '0180069563' }],
    ['a CDC with letters', { associatedCdc: 'a'.repeat(44) }],
    ['a missing CDC', { associatedCdc: undefined }],
  ])('rejects %s', (_name, override) => {
    expect(errorsOf({ ...NCE, ...override })).toEqual(['associatedCdc:schema']);
  });

  it.each([
    ['a missing reason', undefined],
    ['a text reason', '2'],
  ])('rejects %s', (_name, reasonCode) => {
    expect(errorsOf({ ...NCE, reasonCode })).toEqual(['reasonCode:schema']);
  });

  it.each([
    ['receiver', { kind: 'unnamed' }],
    ['operationType', 'B2B'],
    ['location', { departmentCode: 11 }],
  ])('refuses %s, which is taken from the associated invoice', (field, value) => {
    expect(errorsOf({ ...NCE, [field]: value })).toEqual([`${field}:schema`]);
  });

  it('rejects another currency and an invalid item', () => {
    expect(errorsOf({ ...NCE, currency: 'USD' })).toEqual(['currency:schema']);
    expect(errorsOf({ ...NCE, items: [{ ...ITEM, unitCode: 9999 }] })).toEqual([
      'items[0].unitCode:schema',
    ]);
  });

  it('maps to the domain draft', () => {
    const result = parseCreateCreditNote(NCE);
    expect(result.ok && toCreditNoteDraft(result.value)).toEqual({
      associatedCdc: FE_CDC,
      reasonCode: 2,
      items: [ITEM],
      roundingPyg: 0,
    });
  });
});

describe('parseDocumentRequest (the `type` discriminator)', () => {
  it('treats a body without `type` as an FE and keeps it byte-identical', () => {
    const result = parseDocumentRequest(FE);
    const direct = parseCreateDocument(FE);
    expect(result).toMatchObject({ ok: true, type: 'FE' });
    expect(result.ok && result.type === 'FE' && result.value).toEqual(direct.ok && direct.value);
    expect(result.ok && 'type' in result.value).toBe(false);
  });

  it('accepts an explicit `type: FE` and routes `type: NCE` to the credit note', () => {
    expect(parseDocumentRequest({ ...FE, type: 'FE' })).toMatchObject({ ok: true, type: 'FE' });
    expect(parseDocumentRequest(NCE)).toMatchObject({ ok: true, type: 'NCE' });
  });

  it('routes `type: NDE` to the debit note', () => {
    expect(parseDocumentRequest({ ...NCE, type: 'NDE' })).toMatchObject({ ok: true, type: 'NDE' });
  });

  it('routes `type: AFE` to the self-invoice', () => {
    const place = {
      address: 'Calle 1',
      houseNumber: '10',
      departmentCode: 11,
      districtCode: 143,
      cityCode: 3344,
    };
    const AFE = {
      type: 'AFE',
      establishment: '001',
      expeditionPoint: '001',
      seller: { nature: 1, idType: 1, idNumber: '1234567', name: 'Juan Perez', ...place },
      place,
      certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
      items: [{ code: 'A-1', description: 'Maíz', unitCode: 77, quantity: 2, unitPrice: 50000 }],
    };
    expect(parseDocumentRequest(AFE)).toMatchObject({ ok: true, type: 'AFE' });
    expect(parseDocumentRequest({ ...AFE, certificate: undefined })).toMatchObject({ ok: false });
  });

  it.each(['nre', 'nde', 6, null, ''])('rejects the unknown type %j', (type) => {
    expect(parseDocumentRequest({ ...FE, type })).toEqual({
      ok: false,
      errors: [expect.objectContaining({ field: 'type', rule: 'schema' })],
    });
  });

  it('reports the FE problems of a body that is not an object', () => {
    expect(parseDocumentRequest(undefined)).toMatchObject({ ok: false });
    expect(parseDocumentRequest('x')).toMatchObject({ ok: false });
  });

  it('keeps the FE schema from taking a credit note body', () => {
    expect(parseCreateDocument(NCE).ok).toBe(false);
  });
});

/** Spec: HU-E7-02. The NDE body is the NCE one with `type: NDE`: same association and reason. */
describe('parseCreateDebitNote', () => {
  const NDE = { ...NCE, type: 'NDE' };

  it('accepts a debit note and defaults the rounding and currency', () => {
    const withoutRounding = { ...NDE, roundingPyg: undefined };
    const result = parseCreateDebitNote(withoutRounding);
    expect(result).toMatchObject({
      ok: true,
      value: { type: 'NDE', roundingPyg: 0, currency: 'PYG' },
    });
  });

  it('rejects a credit note body and a receiver, which is the invoice one', () => {
    expect(parseCreateDebitNote(NCE)).toMatchObject({ ok: false });
    expect(parseCreateDebitNote({ ...NDE, receiver: { kind: 'unnamed' } })).toMatchObject({
      ok: false,
    });
  });
});
