/** What identifies a document inside its CDC and its immutable association (ADR-0021 D4). */
export interface CorrectionFacts {
  /** iTiDE. */
  documentType: number;
  establishmentCode: string;
  expeditionPointCode: string;
  /** CDC of the associated FE (NCE and NDE), `null` otherwise. */
  associatedCdc: string | null;
}

export type CorrectionReason = 'establishment' | 'expedition_point' | 'associated_cdc';

export type CorrectionImpact =
  /** No CDC component changes: the same row is rewritten and resent. */
  | { kind: 'same_cdc' }
  /** The document type is immutable; a correction cannot turn a document into another type. */
  | { kind: 'type_changed' }
  /** A CDC component changes: the old number is voided and a new document is issued. */
  | { kind: 'reissue'; reasons: CorrectionReason[] };

/** Compares a correction request with the rejected document. RUC, issue date and security code are kept from the row. */
export function classifyCorrection(
  rejected: CorrectionFacts,
  requested: CorrectionFacts,
): CorrectionImpact {
  if (rejected.documentType !== requested.documentType) return { kind: 'type_changed' };
  const reasons: CorrectionReason[] = [];
  if (rejected.establishmentCode !== requested.establishmentCode) reasons.push('establishment');
  if (rejected.expeditionPointCode !== requested.expeditionPointCode) {
    reasons.push('expedition_point');
  }
  if (rejected.associatedCdc !== requested.associatedCdc) reasons.push('associated_cdc');
  return reasons.length > 0 ? { kind: 'reissue', reasons } : { kind: 'same_cdc' };
}
