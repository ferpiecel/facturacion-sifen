import { describe, expect, it } from 'vitest';
import { parseNominateBody } from './nominate-document.request.js';

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
    ['a missing receiver', { reason: 'El cliente pidió su factura' }, 'receiver'],
  ])('rejects %s', (_label, body, field) => {
    const parsed = parseNominateBody(body);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => e.field)).toContain(field);
  });

  it('leaves the reason to the use case', () => {
    expect(parseNominateBody({ ...taxpayer, reason: 'no' })).toMatchObject({ ok: true });
  });
});
