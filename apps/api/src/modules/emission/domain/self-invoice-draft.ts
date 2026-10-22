import { validateInvoiceDraft } from './invoice-draft.js';
import type { DraftItem, ValidationConfig, ValidationError } from './invoice-draft.js';
import { validatePlace, type Place } from './place.js';

/** E301: nature of the seller. */
export const SELLER_NATURES = { 1: 'No contribuyente', 2: 'Extranjero' } as const;
/** E304: identity document type of the seller. */
export const SELLER_ID_TYPES = {
  1: 'Cédula paraguaya',
  2: 'Pasaporte',
  3: 'Cédula extranjera',
  4: 'Carnet de residencia',
} as const;
/** H014: type of the constancia that supports the AFE (H002 = 3). */
export const CERTIFICATE_TYPES = {
  1: 'Constancia de no ser contribuyente',
  2: 'Constancia de microproductores',
} as const;

export interface SelfInvoiceSeller extends Place {
  nature: number;
  idType: number;
  /** dNumIDVen (E306): 1 to 20 characters. */
  idNumber: string;
  /** dNomVen (E307): 4 to 60 characters. */
  name: string;
}

export interface SelfInvoiceDraft {
  seller: SelfInvoiceSeller;
  /** E316-E322: where the transaction took place. */
  place: Place;
  /** H014, H016, H017: the constancia of the seller (H002 = 3, 2416). */
  certificate: { type: number; number: string; control: string };
  /** The items carry no VAT (E730 is not informed for an AFE, 1901): their `vatRate` is 0. */
  items: DraftItem[];
  roundingPyg: number;
}

/** The invoice rules an AFE shares: quantities, prices, amounts and the SEDECO rounding. */
const SHARED_RULES: ReadonlySet<string> = new Set([
  'items-required',
  'quantity-positive',
  'quantity-precision',
  'unit-price-non-negative',
  'unit-price-precision',
  'line-total-precision',
  'amount-range',
  'pyg-integer',
  'rounding-multiple-of-50',
]);

const has = (table: object, key: number): boolean => Object.hasOwn(table, key);

/**
 * Pure pre-SIFEN validation of an AFE (HU-E7-03). The receiver is the issuer itself (D206 = D101,
 * 1317) and the operation is B2C cash (1316, 1503), so none of them is validated here. Collects
 * every violation.
 */
export function validateSelfInvoiceDraft(
  draft: SelfInvoiceDraft,
  config: ValidationConfig,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const add = (field: string, rule: string, message: string, sifenCode?: string) => {
    errors.push({ field, rule, message, ...(sifenCode === undefined ? {} : { sifenCode }) });
  };
  const { seller, certificate } = draft;

  if (!has(SELLER_NATURES, seller.nature)) {
    add('seller.nature', 'self-invoice-seller-nature', 'The seller nature must be 1 or 2 (E301)');
  }
  if (!has(SELLER_ID_TYPES, seller.idType)) {
    add(
      'seller.idType',
      'self-invoice-seller-id-type',
      'The seller document type must be 1 to 4 (E304)',
    );
  }
  if (!has(CERTIFICATE_TYPES, certificate.type)) {
    add(
      'certificate.type',
      'self-invoice-certificate-type',
      'The constancia type must be 1 or 2 (H014)',
    );
  }
  if (!/^\d{11}$/.test(certificate.number)) {
    add(
      'certificate.number',
      'self-invoice-certificate-number',
      'The constancia number must have 11 digits (H016)',
    );
  }
  if (certificate.control.length !== 8) {
    add(
      'certificate.control',
      'self-invoice-certificate-control',
      'The constancia control must have 8 characters (H017)',
    );
  }
  errors.push(
    ...validatePlace('seller', seller, config),
    ...validatePlace('place', draft.place, config),
  );

  const shape = {
    receiver: { kind: 'named' as const, isPublicEntity: false },
    operationType: 'B2C' as const,
    items: draft.items,
    roundingPyg: draft.roundingPyg,
    location: {},
  };
  errors.push(...validateInvoiceDraft(shape, config).filter((e) => SHARED_RULES.has(e.rule)));
  return errors;
}
