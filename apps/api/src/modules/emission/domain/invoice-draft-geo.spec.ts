import { loadGeoCatalog } from '@sifen/sifen-xsd';
import { describe, expect, it } from 'vitest';
import { createGeoCatalog } from '../../geo/domain/geo-catalog.js';
import {
  validateInvoiceDraft,
  type DraftReceiverAddress,
  type InvoiceDraft,
} from './invoice-draft.js';

const geo = { geoCatalog: createGeoCatalog(loadGeoCatalog()), validateGeo: true };

/** Ciudad del Este: department 11, district 145, city 3383 (DNIT table, Nov 2025). */
const ADDRESS: DraftReceiverAddress = {
  street: 'Av. Principal',
  houseNumber: '1',
  districtCode: 145,
  districtDescription: 'CIUDAD DEL ESTE',
  cityCode: 3383,
  cityDescription: 'CIUDAD DEL ESTE',
};

function draft(address: Partial<DraftReceiverAddress> = {}, location = { departmentCode: 11 }) {
  return {
    receiver: { kind: 'named', isPublicEntity: false, address: { ...ADDRESS, ...address } },
    operationType: 'B2B',
    items: [{ quantity: 1, unitPrice: 110_000, vatRate: 10 }],
    roundingPyg: 0,
    location,
  } as InvoiceDraft;
}

// B2F is rejected as unsupported (operationType) before anything else; these tests look at the geography.
const errors = (d: InvoiceDraft, config = geo) =>
  validateInvoiceDraft(d, config).filter((e) => e.field !== 'operationType');
const rules = (d: InvoiceDraft, config = geo) => errors(d, config).map((e) => e.rule);

describe('receiver geography against the DNIT catalog (1325, 1329)', () => {
  it('accepts codes and descriptions that match the table', () => {
    expect(errors(draft())).toEqual([]);
  });

  it('accepts a receiver without district: the city decides it', () => {
    expect(errors(draft({ districtCode: undefined, districtDescription: undefined }))).toEqual([]);
  });

  it('rejects an unknown city and an unknown district', () => {
    expect(rules(draft({ cityCode: 99999 }))).toContain('receiver-city-unknown');
    expect(rules(draft({ districtCode: 9999 }))).toContain('receiver-district-unknown');
  });

  it('rejects a city outside the district', () => {
    expect(rules(draft({ cityCode: 1 }))).toEqual([
      'receiver-city-not-in-district',
      'receiver-city-description-mismatch',
    ]);
  });

  it('rejects a district outside the department', () => {
    expect(rules(draft({}, { departmentCode: 1 }))).toEqual([
      'receiver-district-not-in-department',
    ]);
  });

  it('rejects a city outside the department when the district is not informed', () => {
    const d = draft(
      { districtCode: undefined, districtDescription: undefined },
      { departmentCode: 1 },
    );

    expect(rules(d)).toEqual(['receiver-city-not-in-department']);
  });

  it('rejects descriptions that do not match their code, with the SIFEN code', () => {
    expect(errors(draft({ districtDescription: 'ASUNCION' }))).toEqual([
      expect.objectContaining({
        field: 'receiver.districtDescription',
        rule: 'receiver-district-description-mismatch',
        sifenCode: '1325',
      }),
    ]);
    expect(errors(draft({ cityDescription: 'OTRA' }))).toEqual([
      expect.objectContaining({
        field: 'receiver.cityDescription',
        rule: 'receiver-city-description-mismatch',
        sifenCode: '1329',
      }),
    ]);
  });

  it('checks the district of a B2F receiver, which carries neither department nor city', () => {
    const b2f = {
      ...draft({ cityCode: undefined, cityDescription: undefined }, {} as never),
      operationType: 'B2F',
    } as InvoiceDraft;

    expect(errors(b2f)).toEqual([]);
    expect(
      rules({
        ...b2f,
        receiver: {
          kind: 'named',
          isPublicEntity: false,
          address: {
            ...ADDRESS,
            cityCode: undefined,
            cityDescription: undefined,
            districtCode: 9999,
          },
        },
      }),
    ).toEqual(['receiver-district-unknown']);
  });

  it('does not apply the catalog rules unless they are switched on (signing of earlier documents)', () => {
    const wrong = draft({ cityCode: 1, cityDescription: 'X' });

    expect(errors(wrong, { ...geo, validateGeo: false })).toEqual([]);
    expect(errors(wrong, {} as typeof geo)).toEqual([]);
  });
});
