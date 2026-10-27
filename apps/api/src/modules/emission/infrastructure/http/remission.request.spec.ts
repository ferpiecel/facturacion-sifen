import { describe, expect, it } from 'vitest';
import { parseDocumentRequest } from './credit-note.request.js';
import { parseCreateRemission, toRemissionDraft } from './remission.request.js';

const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const remissionBody = {
  type: 'NRE',
  establishment: '001',
  expeditionPoint: '001',
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
  items: [{ code: 'A-1', description: 'Maíz', unitCode: 77, quantity: 3 }],
};

/** Spec: HU-E7-04. Body of `POST /v1/documents` with `type: "NRE"` (MT v150 E5, E9). */
describe('parseCreateRemission', () => {
  it('accepts a complete body and maps the quantity-only draft', () => {
    const parsed = parseCreateRemission(remissionBody);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(toRemissionDraft(parsed.value)).toMatchObject({
      motive: 1,
      km: 120,
      receiver: { ruc: '80000002-1', cityCode: 3344 },
      transport: { startDate: '2026-10-01', carrier: { contributor: true } },
      items: [{ quantity: 3 }],
    });
  });

  it('refuses a price on an item (E715 read strictly: 1851 forbids the value group)', () => {
    const parsed = parseCreateRemission({
      ...remissionBody,
      items: [{ ...remissionBody.items[0], unitPrice: 10 }],
    });
    expect(parsed.ok).toBe(false);
  });

  it('names every missing or malformed field', () => {
    const parsed = parseCreateRemission({
      ...remissionBody,
      receiver: { ...remissionBody.receiver, ruc: '123', address: undefined },
      transport: {
        ...remissionBody.transport,
        vehicle: { ...remissionBody.transport.vehicle, type: 'Cam' },
      },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['receiver.ruc', 'receiver.address', 'transport.vehicle.type']),
    );
  });

  it('accepts a foreign receiver identified by a document instead of a RUC', () => {
    const { name, ...place } = { ...remissionBody.receiver, ruc: undefined };
    const rest = { name, ...place };
    const foreign = { ...rest, idType: 2, idNumber: 'P123456', countryCode: 'BRA' };
    const parsed = parseCreateRemission({ ...remissionBody, motive: 3, receiver: foreign });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(toRemissionDraft(parsed.value).receiver).toMatchObject({
      idType: 2,
      idNumber: 'P123456',
      countryCode: 'BRA',
    });
    // A receiver with neither a RUC nor a document is refused.
    expect(parseCreateRemission({ ...remissionBody, receiver: rest }).ok).toBe(false);
  });

  it('routes `type: NRE` through the dispatcher', () => {
    expect(parseDocumentRequest(remissionBody)).toMatchObject({ ok: true, type: 'NRE' });
    expect(parseDocumentRequest({ ...remissionBody, items: [] })).toMatchObject({ ok: false });
  });
});
