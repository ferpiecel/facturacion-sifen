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
});
