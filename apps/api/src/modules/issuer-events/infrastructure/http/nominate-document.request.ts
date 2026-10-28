import { z } from 'zod';
import {
  validateAddressBlock,
  validateGeography,
  type ValidationError,
} from '../../../emission/domain/invoice-draft.js';
import { emissionValidationConfig } from '../../../emission/emission-validation-config.js';
import { parseRuc } from '../../../fiscal-config/domain/ruc.js';
import { schemaErrors } from '../../../emission/infrastructure/http/create-document.request.js';
import type { NominationReceiver } from '../../domain/nominate-rules.js';

const details = {
  name: z.string().min(4).max(255),
  tradeName: z.string().min(1).max(255).optional(),
  country: z.string().regex(/^[A-Za-z]{3}$/, 'The country must have three letters'),
  address: z.string().trim().min(1).max(255).optional(),
  /** `dNumCasRec` is `tdNumCas`: a number of up to six digits. */
  houseNumber: z
    .string()
    .regex(/^[0-9]{1,6}$/, 'The house number must be numeric, up to six digits')
    .optional(),
  departmentCode: z.number().int().positive().optional(),
  districtCode: z.number().int().positive().optional(),
  cityCode: z.number().int().positive().optional(),
  phone: z.string().min(6).max(15).optional(),
  mobile: z.string().min(10).max(20).optional(),
  email: z.email().max(80).optional(),
  customerCode: z.string().min(3).max(15).optional(),
};

const taxpayer = z.object({
  kind: z.literal('taxpayer'),
  ruc: z
    .string()
    .regex(/^[1-9][0-9]{2,7}-[0-9]$/, 'The RUC must carry its check digit, 12345678-9')
    .refine((ruc) => {
      try {
        parseRuc(ruc);
        return true;
      } catch {
        return false;
      }
    }, 'The RUC check digit does not match'),
  taxpayerType: z.union([z.literal(1), z.literal(2)]),
  operationType: z.enum(['B2B', 'B2C', 'B2F']),
  ...details,
});

const nonTaxpayer = z.object({
  kind: z.literal('non-taxpayer'),
  /** 5 (innominado) is what a nomination replaces, never its target. */
  documentType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  documentNumber: z.string().regex(/^[0-9A-Za-z-]{1,20}$/, 'Digits, letters and hyphens, up to 20'),
  /** B2B is a sale between taxpayers (NT 014). */
  operationType: z.enum(['B2C', 'B2F']),
  ...details,
});

export const nominateDocumentSchema = z.object({
  receiver: z.discriminatedUnion('kind', [taxpayer, nonTaxpayer]),
  /** Length (5 to 500) is the use case's rule, so it answers like the cancellation reason. */
  reason: z.unknown(),
});

export type NominateDocumentBody = { receiver: NominationReceiver; reason: unknown };

export function parseNominateBody(
  body: unknown,
): { ok: true; value: NominateDocumentBody } | { ok: false; errors: ValidationError[] } {
  const parsed = nominateDocumentSchema.safeParse(body);
  if (parsed.success) {
    const errors = addressErrors(parsed.data.receiver);
    return errors.length === 0 ? { ok: true, value: parsed.data } : { ok: false, errors };
  }
  return {
    ok: false,
    errors: schemaErrors(parsed.error).map((e) => (e.field === '' ? { ...e, field: 'body' } : e)),
  };
}

/** The receiver address rules of the invoice (4470, 1324, 1327, B2F, geography), on the nomination's fields. */
function addressErrors(receiver: NominationReceiver): ValidationError[] {
  const errors: ValidationError[] = [];
  const address =
    receiver.address === undefined
      ? undefined
      : {
          street: receiver.address,
          ...(receiver.houseNumber === undefined ? {} : { houseNumber: receiver.houseNumber }),
          ...(receiver.districtCode === undefined ? {} : { districtCode: receiver.districtCode }),
          ...(receiver.cityCode === undefined ? {} : { cityCode: receiver.cityCode }),
        };
  validateAddressBlock(
    {
      operationType: receiver.operationType,
      unnamed: false,
      address,
      departmentCode: receiver.departmentCode,
    },
    errors,
  );
  const catalog = emissionValidationConfig().geoCatalog;
  if (catalog) validateGeography(address, receiver.departmentCode, catalog, errors);
  return errors.map((e) => ({
    ...e,
    field: e.field.replace(/^location\./, 'receiver.'),
  }));
}
