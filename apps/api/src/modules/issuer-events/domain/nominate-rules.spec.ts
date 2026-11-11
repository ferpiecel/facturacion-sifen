import { describe, expect, it } from 'vitest';
import { validateNomination, type NominationCandidate } from './nominate-rules.js';

const FE: NominationCandidate = {
  documentType: 1,
  status: 'approved',
  receiverKind: 'unnamed',
};

describe('validateNomination (MT v150 11.6, NT 014)', () => {
  it.each(['approved', 'approved_with_observations'])(
    'lets a %s FE with an unnamed receiver go',
    (status) => {
      expect(validateNomination({ ...FE, status })).toBeNull();
    },
  );

  it.each([4, 5, 6, 7])(
    'refuses document type %i, only an FE is nominated (4454)',
    (documentType) => {
      expect(validateNomination({ ...FE, documentType })).toMatchObject({
        rule: 'nominate-requires-fe',
        sifenCode: '4454',
      });
    },
  );

  it.each(['accepted', 'signed', 'rejected', 'cancelled', 'number_voided', 'corrected'])(
    'refuses an FE in status %s, it is not approved (4002)',
    (status) => {
      expect(validateNomination({ ...FE, status })).toMatchObject({
        rule: 'document-not-approved',
        sifenCode: '4002',
      });
    },
  );

  it.each(['named', null] as const)('refuses an FE whose receiver is %s (4469)', (receiverKind) => {
    expect(validateNomination({ ...FE, receiverKind })).toMatchObject({
      rule: 'nominate-receiver-named',
      sifenCode: '4469',
    });
  });

  it('reports the type before the status and the status before the receiver', () => {
    expect(
      validateNomination({ documentType: 5, status: 'rejected', receiverKind: 'named' }),
    ).toMatchObject({ rule: 'nominate-requires-fe' });
    expect(
      validateNomination({ documentType: 1, status: 'rejected', receiverKind: 'named' }),
    ).toMatchObject({ rule: 'document-not-approved' });
  });
});
