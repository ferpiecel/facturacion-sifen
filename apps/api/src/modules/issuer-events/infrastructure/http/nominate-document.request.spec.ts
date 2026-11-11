import { describe, expect, it } from 'vitest';
import { emissionValidationConfig } from '../../../emission/emission-validation-config.js';
import { parseNominateBody } from './nominate-document.request.js';

const catalog = emissionValidationConfig().geoCatalog;
if (!catalog) throw new Error('the geo catalog is required');
const [city, otherCity] = catalog
  .departments()
  .flatMap((d) =>
    (catalog.districtsOf(d.code) ?? []).flatMap((dist) => catalog.citiesOf(dist.code) ?? []),
  );
const cityDistrict = catalog.district(city.districtCode);
const cityDepartment = cityDistrict?.departmentCode;
const elsewhere = catalog.departments().find((d) => d.code !== cityDepartment)?.code;
const address = {
  address: 'Av. Mcal. López',
  houseNumber: '1234',
  departmentCode: cityDepartment,
  districtCode: city.districtCode,
  cityCode: city.code,
};

const taxpayer = {
  receiver: {
    kind: 'taxpayer',
    ruc: '80069563-1',
    taxpayerType: 2,
    name: 'Cliente SA',
    country: 'PRY',
    operationType: 'B2B',
  },
  reason: 'El cliente pidió su factura',
};
const nonTaxpayer = {
  receiver: {
    kind: 'non-taxpayer',
    documentType: 1,
    documentNumber: '1234567',
    name: 'Juan Pérez',
    country: 'PRY',
    operationType: 'B2C',
    email: 'juan@example.com',
  },
  reason: 'El cliente pidió su factura',
};

describe('parseNominateBody', () => {
  it('accepts a taxpayer and a non-taxpayer receiver', () => {
    expect(parseNominateBody(taxpayer)).toMatchObject({ ok: true });
    expect(parseNominateBody(nonTaxpayer)).toMatchObject({ ok: true });
  });

  it('keeps the receiver as the domain names it and the reason apart', () => {
    const parsed = parseNominateBody(nonTaxpayer);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.value.reason).toBe('El cliente pidió su factura');
    expect(parsed.value.receiver).toEqual(nonTaxpayer.receiver);
  });

  it.each([
    ['a body that is not an object', 'x', 'body'],
    [
      'a RUC without check digit',
      { ...taxpayer, receiver: { ...taxpayer.receiver, ruc: '80069563' } },
      'receiver.ruc',
    ],
    [
      'a taxpayer type out of 1|2',
      { ...taxpayer, receiver: { ...taxpayer.receiver, taxpayerType: 3 } },
      'receiver.taxpayerType',
    ],
    [
      'a document type out of 1..5',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, documentType: 6 } },
      'receiver.documentType',
    ],
    [
      'B2B for a non-taxpayer',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, operationType: 'B2B' } },
      'receiver.operationType',
    ],
    [
      'a short name',
      { ...taxpayer, receiver: { ...taxpayer.receiver, name: 'abc' } },
      'receiver.name',
    ],
    [
      'a country that is not three letters',
      { ...taxpayer, receiver: { ...taxpayer.receiver, country: 'PY' } },
      'receiver.country',
    ],
    [
      'an unknown receiver kind',
      { ...taxpayer, receiver: { ...taxpayer.receiver, kind: 'other' } },
      'receiver.kind',
    ],
    [
      'a malformed email',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, email: 'nope' } },
      'receiver.email',
    ],
    [
      'a house number that is not numeric',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, ...address, houseNumber: 'S/N' } },
      'receiver.houseNumber',
    ],
    [
      'a house number over six digits',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, ...address, houseNumber: '1234567' } },
      'receiver.houseNumber',
    ],
    [
      'a document number with a space or a dot',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, documentNumber: '1.234 567' } },
      'receiver.documentNumber',
    ],
    [
      'an unnamed (5) document type as the target',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, documentType: 5 } },
      'receiver.documentType',
    ],
    [
      'a RUC with a wrong check digit',
      { ...taxpayer, receiver: { ...taxpayer.receiver, ruc: '80069563-2' } },
      'receiver.ruc',
    ],
    [
      'a RUC base starting with zero',
      { ...taxpayer, receiver: { ...taxpayer.receiver, ruc: '0123456-0' } },
      'receiver.ruc',
    ],
    [
      'an address without department and city',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, address: 'Av. X', houseNumber: '1' } },
      'receiver.cityCode',
    ],
    [
      'a department without an address',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, departmentCode: cityDepartment } },
      'receiver.address',
    ],
    [
      'an address without house number',
      {
        ...nonTaxpayer,
        receiver: { ...nonTaxpayer.receiver, ...address, houseNumber: undefined },
      },
      'receiver.houseNumber',
    ],
    [
      'a city outside the department',
      {
        ...nonTaxpayer,
        receiver: { ...nonTaxpayer.receiver, ...address, departmentCode: elsewhere },
      },
      'receiver.districtCode',
    ],
    [
      'an unknown city',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, ...address, cityCode: 999999 } },
      'receiver.cityCode',
    ],
    [
      'a B2F receiver with department and city',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, ...address, operationType: 'B2F' } },
      'receiver.cityCode',
    ],
    [
      'a B2F receiver without address (D213, ADR-0017)',
      { ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, operationType: 'B2F' } },
      'receiver.address',
    ],
    [
      'a B2F receiver with a blank address',
      {
        ...nonTaxpayer,
        receiver: { ...nonTaxpayer.receiver, operationType: 'B2F', address: ' ', houseNumber: '1' },
      },
      'receiver.address',
    ],
    [
      'a B2F receiver with an address but no house number',
      {
        ...nonTaxpayer,
        receiver: { ...nonTaxpayer.receiver, operationType: 'B2F', address: 'Rua Foz' },
      },
      'receiver.houseNumber',
    ],
    ['a missing receiver', { reason: 'El cliente pidió su factura' }, 'receiver'],
  ])('rejects %s', (_label, body, field) => {
    const parsed = parseNominateBody(body);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => e.field)).toContain(field);
  });

  it('accepts a full address that nests, and a B2F address without department and city', () => {
    expect(
      parseNominateBody({ ...nonTaxpayer, receiver: { ...nonTaxpayer.receiver, ...address } }),
    ).toMatchObject({ ok: true });
    expect(otherCity).toBeDefined();
    expect(
      parseNominateBody({
        ...nonTaxpayer,
        receiver: {
          ...nonTaxpayer.receiver,
          operationType: 'B2F',
          address: 'Rua Foz',
          houseNumber: '12',
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it('leaves the reason to the use case', () => {
    expect(parseNominateBody({ ...taxpayer, reason: 'no' })).toMatchObject({ ok: true });
  });
});
