import { describe, expect, it } from 'vitest';
import { validateRemissionDraft, type RemissionDraft } from './remission-draft.js';

const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const draft: RemissionDraft = {
  motive: 1,
  responsible: 1,
  km: 120,
  receiver: { ruc: '80000002-1', name: 'Receptor Prueba SA', ...place },
  transport: {
    type: 1,
    modality: 1,
    freightResponsible: 1,
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    departure: place,
    delivery: place,
    vehicle: { type: 'Camion', brand: 'Volvo', idType: 1, idNumber: 'ABC12345' },
    carrier: {
      contributor: true,
      name: 'Transportes SA',
      ruc: '80000003-0',
      address: 'Ruta 2 km 10',
      driver: { name: 'Pedro Gomez', idNumber: '1234567', address: 'Calle 9' },
    },
  },
  items: [{ quantity: 3 }],
};
const rules = (changes: Partial<RemissionDraft>) =>
  validateRemissionDraft({ ...draft, ...changes }, {}).map((e) => e.rule);
const transport = (changes: Partial<RemissionDraft['transport']>) => ({
  transport: { ...draft.transport, ...changes },
});

/** Spec: HU-E7-04. MT v150 E5 (E500-E506), E9 (E900-E997) and the items of the NRE (E7 without prices). */
describe('validateRemissionDraft', () => {
  it('accepts a complete NRE', () => {
    expect(validateRemissionDraft(draft, {})).toEqual([]);
  });

  it('closes the motive (E501, 1 to 14 or 99) and the responsible (E503, 1 to 5)', () => {
    expect(rules({ motive: 15 })).toEqual(['remission-motive']);
    expect(rules({ motive: 99 })).toEqual([]);
    expect(rules({ responsible: 6 })).toEqual(['remission-responsible']);
  });

  it('requires the kilometres (dKmR, 1 to 99999) as an integer', () => {
    expect(rules({ km: 0 })).toEqual(['remission-km']);
    expect(rules({ km: 100_000 })).toEqual(['remission-km']);
    expect(rules({ km: 1.5 })).toEqual(['remission-km']);
  });

  it('checks the invoice date and the transport dates as real calendar days', () => {
    expect(rules({ invoiceDate: '2026-02-30' })).toEqual(['remission-invoice-date']);
    expect(rules(transport({ startDate: '2026-13-01' }))).toEqual(['remission-transport-dates']);
    expect(rules(transport({ endDate: '2026-09-30' }))).toEqual(['remission-transport-dates']);
  });

  it('requires motive 7 to be addressed to the issuer itself (2606)', () => {
    const errors = validateRemissionDraft({ ...draft, motive: 7 }, {}, '80000001-3');
    expect(errors.map((e) => e.rule)).toEqual(['remission-motive-7-receiver']);
    expect(errors[0].sifenCode).toBe('2606');
    expect(
      validateRemissionDraft({ ...draft, motive: 7 }, {}, '80000002-1').map((e) => e.rule),
    ).toEqual([]);
  });

  it('closes type, modality and freight responsible of the transport', () => {
    expect(rules(transport({ type: 3 }))).toEqual(['remission-transport-type']);
    expect(rules(transport({ modality: 5 }))).toEqual(['remission-transport-modality']);
    expect(rules(transport({ freightResponsible: 6 }))).toEqual([
      'remission-transport-freight-responsible',
    ]);
  });

  it('checks the receiver, departure and delivery places', () => {
    expect(rules({ receiver: { ...draft.receiver, departmentCode: 99 } })).toEqual([
      'receiver-department-code',
    ]);
    expect(rules(transport({ departure: { ...place, departmentCode: 99 } }))).toEqual([
      'transport.departure-department-code',
    ]);
    expect(rules(transport({ delivery: { ...place, departmentCode: 99 } }))).toEqual([
      'transport.delivery-department-code',
    ]);
  });

  it('requires a valid RUC for a contributor carrier and a document for the others', () => {
    const carrier = draft.transport.carrier;
    expect(rules(transport({ carrier: { ...carrier, ruc: '80000003-5' } }))).toEqual([
      'remission-carrier-ruc',
    ]);
    expect(rules(transport({ carrier: { ...carrier, ruc: undefined } }))).toEqual([
      'remission-carrier-ruc',
    ]);
    const foreign = { ...carrier, contributor: false, ruc: undefined };
    expect(rules(transport({ carrier: foreign }))).toEqual(['remission-carrier-document']);
    expect(rules(transport({ carrier: { ...foreign, idType: 2, idNumber: 'AB123456' } }))).toEqual(
      [],
    );
  });

  it('reuses the item rules for the quantity and needs at least one item', () => {
    expect(rules({ items: [] })).toEqual(['items-required']);
    expect(rules({ items: [{ quantity: 0 }] })).toEqual(['quantity-positive']);
  });
});
