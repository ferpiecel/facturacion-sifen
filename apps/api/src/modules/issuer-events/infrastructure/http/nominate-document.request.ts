import { z } from 'zod';
import type { ValidationError } from '../../../emission/domain/invoice-draft.js';
import { schemaErrors } from '../../../emission/infrastructure/http/create-document.request.js';
import type { NominationReceiver } from '../../domain/nominate-rules.js';

const details = {
  name: z.string().min(4).max(255),
  tradeName: z.string().min(1).max(255).optional(),
  country: z.string().regex(/^[A-Za-z]{3}$/, 'The country must have three letters'),
  address: z.string().min(1).max(255).optional(),
  houseNumber: z.string().min(1).max(10).optional(),
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
  ruc: z.string().regex(/^[0-9]{3,8}-[0-9]$/, 'The RUC must carry its check digit, 12345678-9'),
  taxpayerType: z.union([z.literal(1), z.literal(2)]),
  operationType: z.enum(['B2B', 'B2C', 'B2F']),
  ...details,
});

const nonTaxpayer = z.object({
  kind: z.literal('non-taxpayer'),
  documentType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  documentNumber: z.string().min(1).max(20),
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
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: schemaErrors(parsed.error).map((e) => (e.field === '' ? { ...e, field: 'body' } : e)),
  };
}
