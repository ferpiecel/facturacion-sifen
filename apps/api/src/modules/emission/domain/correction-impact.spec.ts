import { describe, expect, it } from 'vitest';
import { classifyCorrection } from './correction-impact.js';

const rejected = {
  documentType: 5,
  establishmentCode: '001',
  expeditionPointCode: '002',
  associatedCdc: '1'.repeat(44),
};

/** Spec: HU-E8-01, ADR-0021 D4. */
describe('classifyCorrection', () => {
  it('keeps the CDC when no component of it changes', () => {
    expect(classifyCorrection(rejected, { ...rejected })).toEqual({ kind: 'same_cdc' });
  });

  it('refuses to change the document type', () => {
    expect(classifyCorrection(rejected, { ...rejected, documentType: 6 })).toEqual({
      kind: 'type_changed',
    });
  });

  it.each([
    ['establishment', { establishmentCode: '002' }],
    ['expedition_point', { expeditionPointCode: '001' }],
    ['associated_cdc', { associatedCdc: '2'.repeat(44) }],
  ])('requires a new number when the %s changes', (reason, change) => {
    expect(classifyCorrection(rejected, { ...rejected, ...change })).toEqual({
      kind: 'reissue',
      reasons: [reason],
    });
  });

  it('lists every reason', () => {
    const result = classifyCorrection(rejected, {
      ...rejected,
      establishmentCode: '009',
      expeditionPointCode: '009',
    });
    expect(result).toEqual({ kind: 'reissue', reasons: ['establishment', 'expedition_point'] });
  });
});
