import { describe, expect, it } from 'vitest';
import { nominatedFacts, readNominatedReceiver } from './nominated-receiver.js';

const TAXPAYER = {
  kind: 'taxpayer',
  ruc: '80012345-1',
  taxpayerType: 2,
  name: 'Cliente SA',
  country: 'PRY',
  operationType: 'B2B',
} as const;

/** Spec: HU-E8-05 (NT 015, 2442). The nominated receiver an NCE or NDE takes from its FE. */
describe('nominated receiver', () => {
  it('reads a stored nomination and refuses anything else', () => {
    expect(readNominatedReceiver(TAXPAYER)).toEqual(TAXPAYER);
    expect(readNominatedReceiver(null)).toBeNull();
    expect(readNominatedReceiver({ kind: 'other', name: 'x' })).toBeNull();
    expect(readNominatedReceiver({ kind: 'taxpayer' })).toBeNull();
  });

  it('is a named receiver with the nomination operation and no address when it has none', () => {
    expect(nominatedFacts(TAXPAYER)).toEqual({
      receiver: { kind: 'named', isPublicEntity: false },
      operationType: 'B2B',
      location: {},
    });
  });

  it('carries the address block and the department', () => {
    const facts = nominatedFacts({
      ...TAXPAYER,
      address: 'Avda 1',
      houseNumber: '45',
      districtCode: 143,
      cityCode: 3344,
      departmentCode: 11,
    });
    expect(facts.receiver).toEqual({
      kind: 'named',
      isPublicEntity: false,
      address: { street: 'Avda 1', houseNumber: '45', districtCode: 143, cityCode: 3344 },
    });
    expect(facts.location).toEqual({ departmentCode: 11 });
  });

  describe('an address the note rules would refuse', () => {
    const full = {
      ...TAXPAYER,
      address: 'Avda 1',
      houseNumber: '45',
      districtCode: 143,
      cityCode: 3344,
      departmentCode: 11,
    };

    it.each([
      ['house number', { houseNumber: undefined }],
      ['city', { cityCode: undefined }],
      ['department', { departmentCode: undefined }],
    ])('is read without its address block when the %s is missing', (_name, patch) => {
      const read = readNominatedReceiver({ ...full, ...patch });

      expect(read).toEqual(TAXPAYER);
    });

    it('keeps a complete address and drops the city and department of a B2F', () => {
      expect(readNominatedReceiver(full)).toEqual(full);
      const { cityCode: _city, departmentCode: _department, ...rest } = full;
      expect(readNominatedReceiver({ ...full, operationType: 'B2F' })).toEqual({
        ...rest,
        operationType: 'B2F',
      });
    });
  });
});
