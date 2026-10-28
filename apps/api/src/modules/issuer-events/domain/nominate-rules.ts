/**
 * Rules for nominating an FE issued to an unnamed receiver (HU-E8-05). Pure: no framework, no clock.
 * Sources: MT v150 11.6.1 (4002, 4454, 4469) and NT 014/015/027. 4453 (one nomination per CDC) is the
 * partial unique index of `issuer_events`; 4468 (a CDC of another issuer) cannot arise because a document
 * is read through the tenant's row-level security and a foreign id is simply not found.
 */

/** The receiver a nomination names, by nature (NT 014: `iNatRec` 1 taxpayer, 2 not). */
export type NominationReceiver = NominationIdentity & NominationDetails;

export type NominationIdentity =
  | {
      readonly kind: 'taxpayer';
      /** RUC with its check digit, `12345678-9`. */
      readonly ruc: string;
      /** `iTiContRec`: 1 natural person, 2 legal entity. */
      readonly taxpayerType: 1 | 2;
    }
  | {
      readonly kind: 'non-taxpayer';
      /** `iTipIDRec` (NT 027): 1 to 5. */
      readonly documentType: 1 | 2 | 3 | 4 | 5;
      readonly documentNumber: string;
    };

export interface NominationDetails {
  /** `dNomRec`, 4 to 255 characters. */
  readonly name: string;
  readonly tradeName?: string;
  /** `cPaisRec`, three letters. */
  readonly country: string;
  /** `iTiOpe`: B2B only for a taxpayer. */
  readonly operationType: 'B2B' | 'B2C' | 'B2F';
  readonly address?: string;
  readonly houseNumber?: string;
  readonly departmentCode?: number;
  readonly districtCode?: number;
  readonly cityCode?: number;
  readonly phone?: string;
  readonly mobile?: string;
  readonly email?: string;
  readonly customerCode?: string;
}

export interface NominationCandidate {
  /** `iTiDE` of the document. */
  readonly documentType: number;
  readonly status: string;
  /** `receiver.kind` of the stored request; null when the payload does not say. */
  readonly receiverKind: 'unnamed' | 'named' | null;
}

export type NominationRefusal =
  | { rule: 'nominate-requires-fe'; sifenCode: '4454'; message: string }
  | { rule: 'document-not-approved'; sifenCode: '4002'; message: string }
  | { rule: 'nominate-receiver-named'; sifenCode: '4469'; message: string };

const APPROVED_STATUSES = ['approved', 'approved_with_observations'];
const FE = 1;

/** The first rule the nomination breaks, or null when it may go ahead. */
export function validateNomination(candidate: NominationCandidate): NominationRefusal | null {
  if (candidate.documentType !== FE) {
    return {
      rule: 'nominate-requires-fe',
      sifenCode: '4454',
      message: 'Only an FE (electronic invoice) can be nominated.',
    };
  }
  if (!APPROVED_STATUSES.includes(candidate.status)) {
    return {
      rule: 'document-not-approved',
      sifenCode: '4002',
      message: 'Only a document approved by SIFEN can be nominated.',
    };
  }
  if (candidate.receiverKind !== 'unnamed') {
    return {
      rule: 'nominate-receiver-named',
      sifenCode: '4469',
      message: 'Only an FE issued to an unnamed receiver (innominado) can be nominated.',
    };
  }
  return null;
}
