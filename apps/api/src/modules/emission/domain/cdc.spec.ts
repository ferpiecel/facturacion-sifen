import { describe, expect, it } from 'vitest';
import { buildCdc, computeCdcCheckDigit, InvalidCdcError, parseCdc, type CdcParts } from './cdc.js';

// Manual Técnico v150, §10.1 worked example.
const MT_CDC = '01444444017001001001452822017012515873260988';
const MT_PARTS: CdcParts = {
  documentType: '01',
  rucBase: '44444401',
  rucDv: 7,
  establishment: '001',
  point: '001',
  documentNumber: '0014528',
  taxpayerType: 2,
  issueDate: '2017-01-25',
  emissionType: 1,
  securityCode: '587326098',
};

describe('buildCdc', () => {
  it('builds the MT v150 §10.1 golden vector', () => {
    expect(buildCdc(MT_PARTS)).toBe(MT_CDC);
  });

  it('left-pads short numeric parts', () => {
    const cdc = buildCdc({
      ...MT_PARTS,
      rucBase: '1',
      rucDv: 9,
      establishment: '1',
      point: '2',
      documentNumber: '30',
      securityCode: '5',
      issueDate: '2020-05-07',
    });
    expect(cdc).toHaveLength(44);
    expect(cdc.slice(2, 11)).toBe('000000019');
    expect(cdc.slice(11, 17)).toBe('001002');
    expect(cdc.slice(17, 24)).toBe('0000030');
    expect(cdc.slice(25, 33)).toBe('20200507');
    expect(cdc.slice(34, 43)).toBe('000000005');
  });

  it.each([
    ['documentType', { documentType: '00' }],
    ['documentType', { documentType: '09' }],
    ['rucBase', { rucBase: '123456789' }],
    ['rucDv', { rucDv: 3 }],
    ['establishment', { establishment: '000' }],
    ['establishment', { establishment: '1000' }],
    ['point', { point: '000' }],
    ['point', { point: 'abc' }],
    ['documentNumber', { documentNumber: '0000000' }],
    ['documentNumber', { documentNumber: '10000000' }],
    ['taxpayerType', { taxpayerType: 3 }],
    ['issueDate', { issueDate: '2020-02-30' }],
    ['issueDate', { issueDate: '2021-02-29' }],
    ['issueDate', { issueDate: '20200507' }],
    ['emissionType', { emissionType: 3 }],
    ['securityCode', { securityCode: '000000000' }],
    ['securityCode', { securityCode: '1234567890' }],
    ['securityCode', { securityCode: '0014528', documentNumber: '0014528' }],
  ])('rejects invalid %s', (field, override) => {
    expect(() => buildCdc({ ...MT_PARTS, ...override } as CdcParts)).toThrow(InvalidCdcError);
    try {
      buildCdc({ ...MT_PARTS, ...override } as CdcParts);
    } catch (error) {
      expect((error as InvalidCdcError).field).toBe(field);
    }
  });

  it('accepts a leap day and the field maxima', () => {
    expect(
      buildCdc({
        ...MT_PARTS,
        issueDate: '2020-02-29',
        establishment: '999',
        point: '999',
        documentNumber: '9999999',
        securityCode: '999999999',
      }),
    ).toHaveLength(44);
  });
});

describe('computeCdcCheckDigit', () => {
  it('uses modulo 11 with weights 2..11 (MT vector)', () => {
    expect(computeCdcCheckDigit(MT_CDC.slice(0, 43))).toBe(8);
  });

  it('rejects a base that is not 43 digits', () => {
    expect(() => computeCdcCheckDigit('123')).toThrow(InvalidCdcError);
  });
});

describe('parseCdc', () => {
  it('round-trips the golden vector', () => {
    expect(parseCdc(MT_CDC)).toEqual(MT_PARTS);
    expect(buildCdc(parseCdc(MT_CDC))).toBe(MT_CDC);
  });

  it('rejects a wrong check digit', () => {
    expect(() => parseCdc(`${MT_CDC.slice(0, 43)}7`)).toThrow(InvalidCdcError);
  });

  it.each(['', '123', `${MT_CDC}0`, `${MT_CDC.slice(0, 43)}x`])('rejects malformed %j', (raw) => {
    expect(() => parseCdc(raw)).toThrow(InvalidCdcError);
  });

  it('rejects a well-checksummed CDC with an impossible date', () => {
    const body = `${MT_CDC.slice(0, 25)}20210229${MT_CDC.slice(33, 43)}`;
    expect(() => parseCdc(`${body}${String(computeCdcCheckDigit(body))}`)).toThrow(InvalidCdcError);
  });
});
