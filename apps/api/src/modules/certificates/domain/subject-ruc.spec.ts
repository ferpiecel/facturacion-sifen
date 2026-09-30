import { describe, expect, it } from 'vitest';
import { extractSubjectRuc } from './subject-ruc.js';

describe('extractSubjectRuc (HU-E3-01, §8.7)', () => {
  it('reads the RUC from the subject serialNumber (persona jurídica)', () => {
    expect(extractSubjectRuc('CN=Tenant S.A.\nserialNumber=RUC80000005-6', undefined)).toEqual({
      base: '80000005',
      dv: 6,
    });
  });

  it('reads the RUC from the SubjectAlternativeName (persona física)', () => {
    expect(
      extractSubjectRuc(
        'CN=Juan Perez\nserialNumber=CI1234567',
        'DirName:serialNumber=RUC4490207-7',
      ),
    ).toEqual({ base: '4490207', dv: 7 });
  });

  it('accepts the same RUC in both places', () => {
    expect(
      extractSubjectRuc('serialNumber=RUC80000005-6', 'DirName:serialNumber=RUC80000005-6'),
    ).toEqual({ base: '80000005', dv: 6 });
  });

  it.each([
    ['no RUC at all', 'CN=Tenant', undefined],
    ['a CI instead of a RUC', 'serialNumber=CI1234567', 'email:a@b.py'],
    ['a RUC without the RUC prefix', 'serialNumber=80000005-6', undefined],
    ['a wrong check digit', 'serialNumber=RUC80000005-5', undefined],
    ['a RUC glued to other digits', 'serialNumber=RUC80000005-66', 'DirName:x=RUC180000005-6'],
    ['two different RUCs', 'serialNumber=RUC80000005-6', 'DirName:serialNumber=RUC4490207-7'],
  ])('returns null for %s', (_case, subject, subjectAltName) => {
    expect(extractSubjectRuc(subject, subjectAltName)).toBeNull();
  });
});
