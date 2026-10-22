import { z } from 'zod';
import type { ValidationError } from '../../domain/invoice-draft.js';
import type { SelfInvoiceDraft } from '../../domain/self-invoice-draft.js';
import {
  code,
  digits,
  itemsSchema,
  MAX_ITEMS,
  schemaErrors,
  text,
} from './create-document.request.js';

const fromIssuer = (field: string) =>
  z.never({ error: `The ${field} is taken from the issuer and must not be sent` }).optional();

const houseNumber = z.string().regex(/^\d{1,6}$/, 'House number must be 1 to 6 digits');

/**
 * A place block (E308-E315 and E316-E322). The district is optional in the MT (E312, E319) but
 * xmlgen reads its text from its own table by code, so the contract requires it.
 */
const placeFields = {
  address: text(255),
  houseNumber,
  departmentCode: z.number().int(),
  districtCode: digits(4),
  cityCode: digits(5),
};

/**
 * Body of `POST /v1/documents` for an AFE (`type: "AFE"`, iTiDE 4, MT v150 E4). The receiver, the
 * operation (B2C), the cash condition and the VAT do not exist in the body: they come from the issuer
 * (1315, 1316, 1317, 1503, 1901). Business rules are checked later by the domain.
 */
export const createSelfInvoiceSchema = z.object({
  type: z.literal('AFE'),
  establishment: code(3),
  expeditionPoint: code(3),
  seller: z.object({
    /** iNatVen (E301): 1 = no contribuyente, 2 = extranjero. */
    nature: z.number(),
    /** iTipIDVen (E304): 1 cédula paraguaya, 2 pasaporte, 3 cédula extranjera, 4 carnet de residencia. */
    idType: z.number(),
    idNumber: z
      .string()
      .regex(/^[0-9A-Za-z-]{1,20}$/, 'The document number has 1 to 20 letters, digits or hyphens'),
    name: text(60, 4),
    ...placeFields,
  }),
  /** E316-E322: where the transaction took place. */
  place: z.object(placeFields),
  /** H014, H016, H017: the constancia of the seller (H002 = 3). */
  certificate: z.object({ type: z.number(), number: z.string(), control: z.string() }),
  items: z.array(itemsSchema.element.omit({ vatRate: true })).max(MAX_ITEMS),
  roundingPyg: z.number().default(0),
  currency: z.literal('PYG').default('PYG'),
  receiver: fromIssuer('receiver'),
  operationType: fromIssuer('operationType'),
});

export type CreateSelfInvoiceBody = z.infer<typeof createSelfInvoiceSchema>;

export function parseCreateSelfInvoice(
  body: unknown,
): { ok: true; value: CreateSelfInvoiceBody } | { ok: false; errors: ValidationError[] } {
  const parsed = createSelfInvoiceSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: schemaErrors(parsed.error) };
}

/** The domain view of the body: an AFE item carries no VAT, so its rate is 0 (E730 is not informed). */
export function toSelfInvoiceDraft(body: CreateSelfInvoiceBody): SelfInvoiceDraft {
  return {
    seller: body.seller,
    place: body.place,
    certificate: body.certificate,
    items: body.items.map(({ quantity, unitPrice }) => ({ quantity, unitPrice, vatRate: 0 })),
    roundingPyg: body.roundingPyg,
  };
}
