import { z } from 'zod';
import { parseRuc } from '../../../fiscal-config/domain/ruc.js';
import type { ValidationError } from '../../domain/invoice-draft.js';
import type { AcceptInvoiceInput } from '../../application/accept-invoice.js';

/** MT v150 E001 gCamItem occurs 1-999 times per DE (p. 86). */
const MAX_ITEMS = 999;

const code = (length: number) => z.string().regex(new RegExp(`^\\d{${String(length)}}$`));

const receiver = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('named'),
    ruc: z.string().refine((value) => {
      try {
        parseRuc(value);
        return true;
      } catch {
        return false;
      }
    }, 'Receiver RUC is not a valid RUC (base-DV)'),
    isPublicEntity: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('unnamed'),
    ruc: z.never({ error: 'An unnamed receiver must not carry a RUC' }).optional(),
  }),
]);

/** Body of `POST /v1/documents` for an FE. Business rules are checked later by the domain. */
export const createDocumentSchema = z.object({
  establishment: code(3),
  expeditionPoint: code(3),
  operationType: z.enum(['B2B', 'B2C', 'B2G', 'B2F']),
  receiver,
  items: z
    .array(z.object({ quantity: z.number(), unitPrice: z.number(), vatRate: z.number() }))
    .max(MAX_ITEMS),
  roundingPyg: z.number().default(0),
  location: z.object({ departmentCode: z.number() }),
  currency: z.literal('PYG').default('PYG'),
});

type CreateDocumentBody = z.infer<typeof createDocumentSchema>;

/** Parses the raw body; on failure returns every problem as `{ field, rule, message }`. */
export function parseCreateDocument(
  body: unknown,
): { ok: true; value: CreateDocumentBody } | { ok: false; errors: ValidationError[] } {
  const parsed = createDocumentSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      field: issue.path.reduce<string>(
        (path, key) =>
          typeof key === 'number'
            ? `${path}[${String(key)}]`
            : path
              ? `${path}.${String(key)}`
              : String(key),
        '',
      ),
      rule: 'schema',
      message: issue.message,
    })),
  };
}

/** Maps a parsed body onto the use case input (the draft's `vatRate` is checked by the domain). */
export function toAcceptInvoiceInput(
  body: CreateDocumentBody,
  context: Pick<AcceptInvoiceInput, 'tenantId' | 'actor' | 'payload'>,
): AcceptInvoiceInput {
  return {
    ...context,
    establishmentCode: body.establishment,
    expeditionPointCode: body.expeditionPoint,
    receiverRuc: body.receiver.kind === 'named' ? body.receiver.ruc : null,
    draft: {
      receiver:
        body.receiver.kind === 'named'
          ? { kind: 'named', isPublicEntity: body.receiver.isPublicEntity }
          : { kind: 'unnamed' },
      operationType: body.operationType,
      items: body.items as AcceptInvoiceInput['draft']['items'],
      roundingPyg: body.roundingPyg,
      location: body.location,
    },
  };
}
