import { describe, expect, it } from 'vitest';
import {
  parseCreateDocument,
  toAcceptInvoiceInput,
  toInvoiceDraft,
} from './create-document.request.js';

const NAMED = {
  kind: 'named',
  ruc: '80069563-1',
  isPublicEntity: false,
  name: 'Cliente SA',
  address: 'Av. Mariscal Lopez',
  houseNumber: '123',
  districtCode: 1,
  districtDescription: 'ASUNCION (DISTRITO)',
  cityCode: 1,
  cityDescription: 'ASUNCION (DISTRITO)',
};
const ITEM = {
  code: 'A-001',
  description: 'Servicio de consultoria',
  unitCode: 77,
  quantity: 1,
  unitPrice: 110_000,
  vatRate: 10,
};
const BODY = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: NAMED,
  items: [ITEM],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const fields = (body: unknown) => {
  const result = parseCreateDocument(body);
  return result.ok ? [] : result.errors.map((e) => e.field);
};

/** Spec: HU-E5-01. Every field the signed DE needs is accepted, validated and kept in the payload. */
describe('parseCreateDocument', () => {
  it('keeps the receiver and item XML data in the validated payload', () => {
    const result = parseCreateDocument(BODY);

    expect(result.ok && result.value.receiver).toMatchObject({
      name: 'Cliente SA',
      houseNumber: '123',
    });
    expect(result.ok && result.value.items[0]).toMatchObject({
      code: 'A-001',
      description: 'Servicio de consultoria',
      unitCode: 77,
    });
  });

  it.each([
    'name',
    'address',
    'houseNumber',
    'districtCode',
    'districtDescription',
    'cityCode',
    'cityDescription',
  ])('requires receiver.%s for a named receiver', (key) => {
    const receiver = without(NAMED, key);
    expect(fields({ ...BODY, receiver })).toContain(`receiver.${key}`);
  });

  it.each(['code', 'description', 'unitCode'])('requires items[0].%s', (key) => {
    const item = without(ITEM, key);
    expect(fields({ ...BODY, items: [item] })).toContain(`items[0].${key}`);
  });

  it.each([
    ['name', 'abc'],
    ['name', 'x'.repeat(256)],
    ['address', 'x'.repeat(256)],
    ['houseNumber', '1234567'],
    ['houseNumber', 'S/N'],
    ['districtCode', 12345],
    ['districtCode', 0],
    ['cityCode', 123456],
    ['districtDescription', 'x'.repeat(31)],
    ['cityDescription', '   '],
    ['address', 'Av. Mariscal\nLopez'],
    ['name', 'Cliente\rSA'],
    ['districtDescription', 'ASU\u0000NCION'],
    ['districtCode', 1.5],
    ['districtCode', '1'],
    ['cityCode', 1.5],
    ['cityCode', Number.NaN],
  ])('rejects receiver.%s = %j (XSD limits)', (key, value) => {
    expect(fields({ ...BODY, receiver: { ...NAMED, [key]: value } })).toContain(`receiver.${key}`);
  });

  it.each([
    ['code', ''],
    ['code', 'x'.repeat(51)],
    ['description', '  '],
    ['description', 'x'.repeat(2001)],
    ['unitCode', 1],
    ['unitCode', 77.5],
    ['unitCode', '77'],
    ['unitCode', Number.NaN],
    ['description', 'linea\none'],
    ['code', 'A\t001'],
  ])('rejects items[0].%s = %j (XSD limits)', (key, value) => {
    expect(fields({ ...BODY, items: [{ ...ITEM, [key]: value }] })).toContain(`items[0].${key}`);
  });

  it('accepts the XSD maxima', () => {
    const receiver = {
      ...NAMED,
      name: 'x'.repeat(255),
      address: 'x'.repeat(255),
      houseNumber: '999999',
    };
    const item = { ...ITEM, code: 'x'.repeat(50), description: 'x'.repeat(2000) };
    expect(parseCreateDocument({ ...BODY, receiver, items: [item] }).ok).toBe(true);
  });

  it('needs no receiver data for an unnamed receiver and forbids a name (NT 024: fixed "Sin Nombre")', () => {
    expect(parseCreateDocument({ ...BODY, receiver: { kind: 'unnamed' } }).ok).toBe(true);
    expect(fields({ ...BODY, receiver: { kind: 'unnamed', name: 'Juan' } })).toContain(
      'receiver.name',
    );
  });
});

describe('toInvoiceDraft', () => {
  const draftOf = (body: unknown) => {
    const result = parseCreateDocument(body);
    if (!result.ok) throw new Error('fixture must parse');
    return toInvoiceDraft(result.value);
  };

  it('carries the address block and the department into the draft', () => {
    const draft = draftOf(BODY);

    expect(draft.receiver).toEqual({
      kind: 'named',
      isPublicEntity: false,
      address: { street: 'Av. Mariscal Lopez', houseNumber: '123', cityCode: 1 },
    });
    expect(draft.location).toEqual({ departmentCode: 11 });
  });

  it('feeds the same draft to the acceptance use case', () => {
    const result = parseCreateDocument(BODY);
    if (!result.ok) throw new Error('fixture must parse');
    const input = toAcceptInvoiceInput(result.value, {
      tenantId: 't',
      actor: { type: 'api_key', id: 'k' },
      payload: BODY,
      idempotencyKey: 'i',
    } as never);

    expect(input.draft).toEqual(toInvoiceDraft(result.value));
  });
});
