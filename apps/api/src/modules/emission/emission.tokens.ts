/** Injection token for the `acceptInvoice` application function. */
export const ACCEPT_INVOICE = Symbol('AcceptInvoice');

/** Injection token for the `getDocument` application function. */
export const GET_DOCUMENT = Symbol('GetDocument');

/** Injection token for the `getKude` application function. */
export const GET_KUDE = Symbol('GetKude');

/** Injection token for the `acceptCreditNote` application function. */
export const ACCEPT_CREDIT_NOTE = Symbol('AcceptCreditNote');

/**
 * Whether `POST /v1/documents` accepts `type: "NCE"` (HU-E7-01). Off until the worker can sign a
 * credit note (slice E): the API must never accept a document the worker cannot sign.
 */
export const CREDIT_NOTES_ENABLED = Symbol('CreditNotesEnabled');
