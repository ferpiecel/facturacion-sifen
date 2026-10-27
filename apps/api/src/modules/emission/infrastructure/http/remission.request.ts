import { z } from 'zod';
import { parseRuc } from '../../../fiscal-config/domain/ruc.js';
import type { ValidationError } from '../../domain/invoice-draft.js';
import type { RemissionDraft } from '../../domain/remission-draft.js';
import { code, itemsSchema, MAX_ITEMS, schemaErrors, text } from './create-document.request.js';
import { placeFields } from './self-invoice.request.js';

const rucText = (what: string) =>
  z.string().refine((value) => {
    try {
      parseRuc(value);
      return true;
    } catch {
      return false;
    }
  }, `${what} is not a valid RUC (base-DV)`);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a day written AAAA-MM-DD');

/**
 * Body of `POST /v1/documents` for an NRE (`type: "NRE"`, iTiDE 7, MT v150 E5 and E9). It has no
 * operation, money or VAT: an item carries a code, a description, a unit and a quantity (no price,
 * 1851; E715 is read in its strict form). The receiver address is mandatory (1318). The code
 * tables and the dates are checked later by the domain.
 */
export const createRemissionSchema = z.object({
  type: z.literal('NRE'),
  establishment: code(3),
  expeditionPoint: code(3),
  /** iMotEmiNR (E501): 1 to 14, or 99 (other). */
  motive: z.number(),
  /** iRespEmiNR (E503). */
  responsible: z.number(),
  /** dKmR (E505): estimated kilometres. */
  km: z.number(),
  /** dFecEm (E506): date of the invoice the goods travel with. */
  invoiceDate: day.optional(),
  receiver: z
    .object({
      /** D206; omitted for a non-taxpayer receiver, who then gives `idType` and `idNumber`. */
      ruc: rucText('Receiver RUC').optional(),
      /** iTipIDRec (D208) and dNumIDRec (D210): the document of a receiver without RUC. */
      idType: z.number().optional(),
      idNumber: text(20).optional(),
      /** cPaisRec: ISO 3166 alpha-3. */
      countryCode: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
      /** dNomRec (D211): tdNombre, 4..255. */
      name: text(255, 4),
      ...placeFields,
    })
    .refine((r) => r.ruc !== undefined || (r.idType !== undefined && r.idNumber !== undefined), {
      message: 'A receiver needs a RUC or a document type and number',
      path: ['ruc'],
    }),
  transport: z.object({
    /** iTipTrans (E901): 1 own, 2 third party. */
    type: z.number(),
    /** iModTrans (E903): 1 land, 2 river, 3 air, 4 multimodal. */
    modality: z.number(),
    /** iRespFlete (E905). */
    freightResponsible: z.number(),
    startDate: day,
    endDate: day,
    departure: z.object(placeFields),
    delivery: z.object(placeFields),
    vehicle: z.object({
      type: text(10, 4),
      brand: text(10),
      /** dTipIdenVeh (E970): 1 vehicle identification number, 2 plate. */
      idType: z.number(),
      idNumber: text(20),
    }),
    carrier: z.object({
      contributor: z.boolean(),
      name: text(60, 4),
      ruc: rucText('Carrier RUC').optional(),
      idType: z.number().optional(),
      idNumber: text(20).optional(),
      /** dDomFisc (E992). */
      address: text(150),
      driver: z.object({ name: text(60, 4), idNumber: text(20), address: text(150) }),
    }),
  }),
  items: z
    .array(itemsSchema.element.omit({ unitPrice: true, vatRate: true }).strict())
    .min(1)
    .max(MAX_ITEMS),
});

export type CreateRemissionBody = z.infer<typeof createRemissionSchema>;

export function parseCreateRemission(
  body: unknown,
): { ok: true; value: CreateRemissionBody } | { ok: false; errors: ValidationError[] } {
  const parsed = createRemissionSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: schemaErrors(parsed.error) };
}

/** The domain view of the body: the items keep their quantity only. */
export function toRemissionDraft(body: CreateRemissionBody): RemissionDraft {
  const { motive, responsible, km, invoiceDate, receiver, transport, items } = body;
  return {
    motive,
    responsible,
    km,
    invoiceDate,
    receiver,
    transport,
    items: items.map(({ quantity }) => ({ quantity })),
  };
}
