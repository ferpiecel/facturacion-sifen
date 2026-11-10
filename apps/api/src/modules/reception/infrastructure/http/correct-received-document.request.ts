import { z } from 'zod';
import type {
  CorrectReceivedDocumentInput,
  HeaderPatch,
  ItemPatch,
} from '../../application/correct-received-document.js';

/** Decimal STRING (ADR-0018): plain digits with an optional fraction, never a JSON number. */
const decimal = z.string().regex(/^-?\d{1,15}(?:\.\d{1,8})?$/, 'Must be a decimal string');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
const text = z.string().min(1).max(500);

/** Every field is optional (absent keeps the stored value) and nullable (null clears it). */
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const item = z.strictObject({
  position: z.number().int().min(1).max(999_999),
  remove: z.boolean().optional(),
  description: optional(text),
  product_code: optional(text),
  quantity: optional(decimal),
  unit_of_measure: optional(text),
  unit_price: optional(decimal),
  discount: optional(decimal),
  subtotal: optional(decimal),
  vat_rate: optional(z.union([z.literal(0), z.literal(5), z.literal(10)])),
  taxable_base: optional(decimal),
  vat_amount: optional(decimal),
});

/**
 * Mirrors the nested shape of `GET /v1/received-documents/{id}` so an ERP can send back what it
 * read. Unknown fields are rejected (strict objects), as are non-string amounts.
 */
export const correctReceivedDocumentRequestSchema = z.strictObject({
  /** The `version` the caller read (optimistic lock). */
  version: z.number().int().min(1),
  confirm: z.boolean().optional(),
  document_type: optional(z.number().int()),
  timbrado: optional(text),
  series: optional(text),
  establishment_code: optional(text),
  expedition_point_code: optional(text),
  document_sequence: optional(text),
  issued_on: optional(date),
  currency: z.string().optional(),
  exchange_rate: optional(decimal),
  issuer: z
    .strictObject({
      ruc: optional(text),
      legal_name: optional(text),
      trade_name: optional(text),
      address: optional(text),
      economic_activity: optional(text),
    })
    .optional(),
  receiver: z
    .strictObject({
      ruc: optional(text),
      legal_name: optional(text),
      type: optional(z.number().int()),
    })
    .optional(),
  payment: z
    .strictObject({
      condition: optional(z.enum(['cash', 'credit'])),
      credit_term_days: optional(z.number().int().min(0)),
      method: optional(text),
      due_on: optional(date),
      paid_on: optional(date),
    })
    .optional(),
  totals: z
    .strictObject({
      exempt: optional(decimal),
      zero_rated: optional(decimal),
      taxable_5: optional(decimal),
      taxable_10: optional(decimal),
      vat_5: optional(decimal),
      vat_10: optional(decimal),
      total_vat: optional(decimal),
      discount: optional(decimal),
      total_amount: optional(decimal),
      total_pyg: optional(decimal),
    })
    .optional(),
  items: z.array(item).max(999).optional(),
});

type Wire = z.infer<typeof correctReceivedDocumentRequestSchema>;

export type ParsedCorrection =
  | {
      readonly ok: true;
      readonly value: Omit<CorrectReceivedDocumentInput, 'tenantId' | 'id' | 'actorId'>;
    }
  | { readonly ok: false; readonly issues: readonly { path: string; message: string }[] };

/** Keeps only the keys the caller sent, so "absent" and "null" stay different. */
const sent = <T extends object>(entries: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as Partial<T>;

function toHeaderPatch(wire: Wire): HeaderPatch {
  const { issuer, receiver, payment, totals } = wire;
  return sent({
    documentType: wire.document_type,
    timbrado: wire.timbrado,
    series: wire.series,
    establishmentCode: wire.establishment_code,
    expeditionPointCode: wire.expedition_point_code,
    documentSequence: wire.document_sequence,
    issuedOn: wire.issued_on,
    currency: wire.currency,
    exchangeRate: wire.exchange_rate,
    issuerRuc: issuer?.ruc,
    issuerLegalName: issuer?.legal_name,
    issuerTradeName: issuer?.trade_name,
    issuerAddress: issuer?.address,
    issuerEconomicActivity: issuer?.economic_activity,
    receiverRuc: receiver?.ruc,
    receiverLegalName: receiver?.legal_name,
    receiverType: receiver?.type,
    paymentCondition: payment?.condition,
    creditTermDays: payment?.credit_term_days,
    paymentMethod: payment?.method,
    dueOn: payment?.due_on,
    paidOn: payment?.paid_on,
    totalExempt: totals?.exempt,
    totalZeroRated: totals?.zero_rated,
    taxable5: totals?.taxable_5,
    taxable10: totals?.taxable_10,
    vat5: totals?.vat_5,
    vat10: totals?.vat_10,
    totalVat: totals?.total_vat,
    totalDiscount: totals?.discount,
    totalAmount: totals?.total_amount,
    totalPyg: totals?.total_pyg,
  });
}

const toItemPatch = (wire: z.infer<typeof item>): ItemPatch =>
  sent({
    position: wire.position,
    remove: wire.remove,
    description: wire.description,
    productCode: wire.product_code,
    quantity: wire.quantity,
    unitOfMeasure: wire.unit_of_measure,
    unitPrice: wire.unit_price,
    discount: wire.discount,
    subtotal: wire.subtotal,
    vatRate: wire.vat_rate,
    taxableBase: wire.taxable_base,
    vatAmount: wire.vat_amount,
  }) as ItemPatch;

/** Validates the PATCH body; the issues carry paths and messages, never the submitted values. */
export function parseCorrectionRequest(body: unknown): ParsedCorrection {
  const parsed = correctReceivedDocumentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const wire = parsed.data;
  return {
    ok: true,
    value: {
      expectedVersion: wire.version,
      confirm: wire.confirm,
      header: toHeaderPatch(wire),
      items: wire.items?.map(toItemPatch),
    },
  };
}
