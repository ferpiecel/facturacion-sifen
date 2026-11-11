/** Injection token for the `acceptInvoice` application function. */
export const ACCEPT_INVOICE = Symbol('AcceptInvoice');

/** Injection token for the `getDocument` application function. */
export const GET_DOCUMENT = Symbol('GetDocument');

/** Injection token for the `getKude` application function. */
export const GET_KUDE = Symbol('GetKude');

/** Injection token for the `acceptCreditNote` application function. */
export const ACCEPT_CREDIT_NOTE = Symbol('AcceptCreditNote');
/** Injection token for the `acceptDebitNote` application function (NDE). */
export const ACCEPT_DEBIT_NOTE = Symbol('AcceptDebitNote');
/** Injection token for the `acceptSelfInvoice` application function (AFE). */
export const ACCEPT_SELF_INVOICE = Symbol('AcceptSelfInvoice');
/** Injection token for the `acceptRemission` application function (NRE). */
export const ACCEPT_REMISSION = Symbol('AcceptRemission');

/** Injection token for the `waitForDocument` application function (HU-E6-06, `?wait=true`). */
export const WAIT_FOR_DOCUMENT = Symbol('WaitForDocument');
/** Injection token for the `correctDocument` application function (HU-E8-01). */
export const CORRECT_DOCUMENT = Symbol('CorrectDocument');
