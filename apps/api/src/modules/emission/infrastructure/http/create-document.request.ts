import { z } from 'zod';
import { parseRuc } from '../../../fiscal-config/domain/ruc.js';
import { isUnitOfMeasureCode } from '../../domain/unit-of-measure.js';
import type { ValidationError } from '../../domain/invoice-draft.js';
import type { AcceptInvoiceInput } from '../../application/accept-invoice.js';

/** MT v150 E001 gCamItem occurs 1-999 times per DE (p. 86). */
const MAX_ITEMS = 999;

/** `noEmptyString` (DE_Types_v150.xsd:1724): at least one non-whitespace character. */
const text = (max: number, min = 1) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length >= min && value.trim().length > 0, {
      error: `Must have at least ${String(min)} non-blank characters`,
    });

const digits = (max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(10 ** max - 1);

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
    /** dNomRec (D109): tdNombre, 4..255 (DE_Types_v150.xsd:2242). */
    name: text(255, 4),
    /** dDirRec (D110): tdDirec, up to 255 (:2206). */
    address: text(255),
    /** dNumCasRec (D111): tdNumCas, integer >= 0 of up to 6 digits (:2217), kept as text. */
    houseNumber: z.string().regex(/^\d{1,6}$/, 'House number must be 1 to 6 digits'),
    /** cDisRec / dDesDisRec (D113/D114): tDistrito 4 digits (:1789), description 1..30 (:1801). */
    districtCode: digits(4),
    districtDescription: text(30),
    /** cCiuRec / dDesCiuRec (D115/D116): tCiudad 5 digits (:1764), description up to 30 (:1776). */
    cityCode: digits(5),
    cityDescription: text(30),
  }),
  z.object({
    kind: z.literal('unnamed'),
    ruc: z.never({ error: 'An unnamed receiver must not carry a RUC' }).optional(),
    /** NT 024: the DE of an innominado receiver carries the fixed name "Sin Nombre". */
    name: z
      .never({ error: 'An unnamed receiver has a fixed name and must not carry one' })
      .optional(),
  }),
]);

/** Body of `POST /v1/documents` for an FE. Business rules are checked later by the domain. */
export const createDocumentSchema = z.object({
  establishment: code(3),
  expeditionPoint: code(3),
  operationType: z.enum(['B2B', 'B2C', 'B2G', 'B2F']),
  receiver,
  items: z
    .array(
      z.object({
        /** dCodInt (E701): tdCodInt, 1..50 (DE_Types_v150.xsd:1156). */
        code: text(50),
        /** dDesProSer (E708): 1..2000 (DE_v150.xsd:878). */
        description: text(2000),
        /** cUniMed (E709): closed DNCP list. */
        unitCode: z
          .number()
          .refine(isUnitOfMeasureCode, 'Unit of measure code is not in the cUniMed list'),
        quantity: z.number(),
        unitPrice: z.number(),
        vatRate: z.number(),
      }),
    )
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
  context: Pick<AcceptInvoiceInput, 'tenantId' | 'actor' | 'payload' | 'idempotencyKey'>,
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
