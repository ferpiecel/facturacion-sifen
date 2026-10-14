import { z } from 'zod';
import type { ValidationError } from '../../domain/invoice-draft.js';
import type { CreditNoteDraft } from '../../domain/credit-note-draft.js';
import {
  code,
  itemsSchema,
  parseCreateDocument,
  schemaErrors,
  type CreateDocumentBody,
} from './create-document.request.js';

/** A field the NCE takes from the associated invoice (ADR-0019 D3), so the integrator must not send it. */
const fromInvoice = (field: string) =>
  z
    .never({ error: `The ${field} is taken from the associated invoice and must not be sent` })
    .optional();

/**
 * Body of `POST /v1/documents` for an NCE (`type: "NCE"`, iTiDE 5). There is no receiver, operation
 * type or location: they come from the FE the credit note is associated to (2441 holds by construction).
 * Business rules (existence, state, sum, reasons) are checked later by the domain.
 */
export const createCreditNoteSchema = z.object({
  type: z.literal('NCE'),
  establishment: code(3),
  expeditionPoint: code(3),
  /** H004 `dCdCDERef` (H002 = 1): CDC of the FE being credited, 44 digits. */
  associatedCdc: z.string().regex(/^[0-9]{44}$/, 'The associated CDC must have 44 digits'),
  /** E401 `iMotEmi`: 1..8, validated against the reasons table by the domain (1452). */
  reasonCode: z.number(),
  items: itemsSchema,
  roundingPyg: z.number().default(0),
  currency: z.literal('PYG').default('PYG'),
  receiver: fromInvoice('receiver'),
  operationType: fromInvoice('operationType'),
  location: fromInvoice('location'),
});

export type CreateCreditNoteBody = z.infer<typeof createCreditNoteSchema>;

export function parseCreateCreditNote(
  body: unknown,
): { ok: true; value: CreateCreditNoteBody } | { ok: false; errors: ValidationError[] } {
  const parsed = createCreditNoteSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: schemaErrors(parsed.error) };
}

/** The domain view of the body. */
export function toCreditNoteDraft(body: CreateCreditNoteBody): CreditNoteDraft {
  return {
    associatedCdc: body.associatedCdc,
    reasonCode: body.reasonCode,
    items: body.items as CreditNoteDraft['items'],
    roundingPyg: body.roundingPyg,
  };
}

export type ParsedDocumentRequest =
  | { ok: true; type: 'FE'; value: CreateDocumentBody }
  | { ok: true; type: 'NCE'; value: CreateCreditNoteBody }
  | { ok: false; errors: ValidationError[] };

/**
 * Dispatches on the `type` discriminator (ADR-0019 D1): absent or `FE` is an invoice, exactly as
 * before; `NCE` is a credit note; anything else is a schema error on `type`.
 */
export function parseDocumentRequest(body: unknown): ParsedDocumentRequest {
  const type =
    typeof body === 'object' && body !== null && Object.hasOwn(body, 'type')
      ? (body as { type: unknown }).type
      : undefined;
  if (type === 'NCE') {
    const parsed = parseCreateCreditNote(body);
    return parsed.ok ? { ok: true, type: 'NCE', value: parsed.value } : parsed;
  }
  if (type !== undefined && type !== 'FE') {
    return {
      ok: false,
      errors: [{ field: 'type', rule: 'schema', message: 'The type must be "FE" or "NCE"' }],
    };
  }
  const parsed = parseCreateDocument(body);
  return parsed.ok ? { ok: true, type: 'FE', value: parsed.value } : parsed;
}
