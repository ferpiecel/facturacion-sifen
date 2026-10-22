import { z } from 'zod';
import { parseRuc } from '../../../fiscal-config/domain/ruc.js';
import { isUnitOfMeasureCode } from '../../domain/unit-of-measure.js';
import { isPlainEmailAddress } from '../../../email/domain/plain-email-address.js';
import type { ValidationError } from '../../domain/invoice-draft.js';
import type { AcceptInvoiceInput } from '../../application/accept-invoice.js';

/** `tEmail` (DE_Types_v150.xsd:10). */
const TEMAIL = /^[0-9a-zA-Z][0-9a-zA-Z.\-_]*@([0-9a-zA-Z][0-9a-zA-Z\-_]*\.)+[a-zA-Z]{2,9}$/;

/** MT v150 E001 gCamItem occurs 1-999 times per DE (p. 86). */
const MAX_ITEMS = 999;

/** `noEmptyString` (DE_Types_v150.xsd:1724): at least one non-whitespace character. */
// eslint-disable-next-line no-control-regex -- XSD `.` excludes line breaks; control characters never sign
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const text = (max: number, min = 1) =>
  z
    .string()
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), {
      error: 'Must not contain line breaks or control characters',
    })
    .refine((value) => value.trim().length >= min && value.trim().length > 0, {
      error: `Must have at least ${String(min)} non-blank characters`,
    });

const digits = (max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(10 ** max - 1);

export const code = (length: number) => z.string().regex(new RegExp(`^\\d{${String(length)}}$`));

const receiver = z.discriminatedUnion('kind', [
  z
    .object({
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
      /**
       * Address block (D213-D223), all optional (0-1): the cross-field rules (house number, department,
       * city, B2F) live in `validateInvoiceDraft`; here only the pairs that SIFEN ties together.
       */
      /** dDirRec (D213): tdDirec, up to 255 (:2206). */
      address: text(255).optional(),
      /** dNumCasRec (D218): tdNumCas, integer >= 0 of up to 6 digits (:2217), kept as text. */
      houseNumber: z
        .string()
        .regex(/^\d{1,6}$/, 'House number must be 1 to 6 digits')
        .optional(),
      /** cDisRec / dDesDisRec (D221/D222): tDistrito 4 digits (:1789), description 1..30 (:1801). */
      districtCode: digits(4).optional(),
      districtDescription: text(30).optional(),
      /** cCiuRec / dDesCiuRec (D223/D224): tCiudad 5 digits (:1764), description up to 30 (:1776). */
      cityCode: digits(5).optional(),
      cityDescription: text(30).optional(),
      /**
       * dEmailRec (D213): tEmail pattern (DE_Types_v150.xsd:7), 3 to 80 characters (MT v150). One plain
       * address: the same check the mailer relies on, so a list or a display name never reaches it.
       */
      email: z
        .string()
        .min(3)
        .max(80)
        .regex(TEMAIL, 'Receiver email does not match the SIFEN tEmail pattern')
        .refine(isPlainEmailAddress, 'Receiver email must be a single plain address')
        .optional(),
    })
    .superRefine((receiver, ctx) => {
      if (
        receiver.address === undefined &&
        (receiver.houseNumber ?? receiver.districtCode ?? receiver.cityCode) !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['address'],
          message: 'The address is required when house number, district or city are informed',
        });
      }
      const pairs = [
        ['districtCode', 'districtDescription'],
        ['cityCode', 'cityDescription'],
      ] as const;
      for (const [code, description] of pairs) {
        if ((receiver[code] === undefined) !== (receiver[description] === undefined)) {
          const missing = receiver[code] === undefined ? code : description;
          ctx.addIssue({
            code: 'custom',
            path: [missing],
            message: `${code} and ${description} must be informed together`,
          });
        }
      }
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

/** The item list shared by the FE and the NCE (E8, up to 999 items). */
export const itemsSchema = z
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
  .max(MAX_ITEMS);

/** Body of `POST /v1/documents` for an FE. Business rules are checked later by the domain. */
export const createDocumentSchema = z.object({
  /** Document type (ADR-0019 D1): `FE` when absent, so every body accepted before keeps its meaning. */
  type: z.literal('FE').optional(),
  establishment: code(3),
  expeditionPoint: code(3),
  operationType: z
    .enum(['B2B', 'B2C', 'B2G', 'B2F'])
    .describe(
      'B2G y B2F no están soportados todavía: responden 422 (operation-type-not-supported).',
    ),
  receiver,
  items: itemsSchema,
  roundingPyg: z.number().default(0),
  /** cDepRec (D219): the receiver department, required with an address unless B2F. */
  location: z.object({ departmentCode: z.number().optional() }).default({}),
  currency: z.literal('PYG').default('PYG'),
});

export type CreateDocumentBody = z.infer<typeof createDocumentSchema>;

/** Parses the raw body; on failure returns every problem as `{ field, rule, message }`. */
export function parseCreateDocument(
  body: unknown,
): { ok: true; value: CreateDocumentBody } | { ok: false; errors: ValidationError[] } {
  const parsed = createDocumentSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: schemaErrors(parsed.error) };
}

/** Every Zod issue as `{ field, rule: 'schema', message }`. */
export function schemaErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
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
  }));
}

/** The domain view of the body: the address block is present only when the receiver informs it. */
export function toInvoiceDraft(body: CreateDocumentBody): AcceptInvoiceInput['draft'] {
  const { receiver } = body;
  return {
    receiver:
      receiver.kind === 'named'
        ? {
            kind: 'named',
            isPublicEntity: receiver.isPublicEntity,
            ...(receiver.address === undefined
              ? {}
              : {
                  address: {
                    street: receiver.address,
                    ...(receiver.houseNumber === undefined
                      ? {}
                      : { houseNumber: receiver.houseNumber }),
                    ...(receiver.districtCode === undefined
                      ? {}
                      : {
                          districtCode: receiver.districtCode,
                          districtDescription: receiver.districtDescription,
                        }),
                    ...(receiver.cityCode === undefined
                      ? {}
                      : { cityCode: receiver.cityCode, cityDescription: receiver.cityDescription }),
                  },
                }),
          }
        : { kind: 'unnamed' },
    operationType: body.operationType,
    items: body.items as AcceptInvoiceInput['draft']['items'],
    roundingPyg: body.roundingPyg,
    location: body.location,
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
    draft: toInvoiceDraft(body),
  };
}
