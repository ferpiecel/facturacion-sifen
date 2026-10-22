import { describe, expect, it } from 'vitest';
import { parseCreateSelfInvoice, toSelfInvoiceDraft } from './self-invoice.request.js';

const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const body = {
  type: 'AFE',
  establishment: '001',
  expeditionPoint: '001',
  seller: { nature: 1, idType: 1, idNumber: '1234567', name: 'Juan Perez', ...place },
  place,
  certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
  items: [{ code: 'A-1', description: 'Maíz', unitCode: 77, quantity: 2, unitPrice: 50000 }],
};

/** Spec: HU-E7-03. Body of `POST /v1/documents` with `type: "AFE"` (MT v150 E4, H, ADR-0019 D1). */
describe('parseCreateSelfInvoice', () => {
  it('accepts a complete body: no receiver, no VAT and the PYG currency by default', () => {
    const parsed = parseCreateSelfInvoice(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.currency).toBe('PYG');
    expect(toSelfInvoiceDraft(parsed.value)).toMatchObject({
      seller: { nature: 1, name: 'Juan Perez', cityCode: 3344 },
      place: { departmentCode: 11 },
      certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
      items: [{ quantity: 2, unitPrice: 50000, vatRate: 0 }],
      roundingPyg: 0,
    });
  });

  it('names every missing field and refuses what the AFE takes from the issuer', () => {
    const parsed = parseCreateSelfInvoice({
      ...body,
      seller: { ...body.seller, name: 'Ana', districtCode: undefined },
      certificate: undefined,
      receiver: { kind: 'unnamed' },
      operationType: 'B2C',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => e.field).sort()).toEqual([
      'certificate',
      'operationType',
      'receiver',
      'seller.districtCode',
      'seller.name',
    ]);
  });
});
