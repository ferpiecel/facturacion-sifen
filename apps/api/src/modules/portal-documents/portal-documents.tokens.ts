/** Injection token for the `listPortalDocuments` application function. */
export const LIST_PORTAL_DOCUMENTS = Symbol('ListPortalDocuments');

/** Injection token for the `getPortalDocument` application function. */
export const GET_PORTAL_DOCUMENT = Symbol('GetPortalDocument');

/** Injection token for the `getPortalXml` application function. */
export const GET_PORTAL_XML = Symbol('GetPortalXml');

/** Injection token for the `getKude` application function wired to the portal source. */
export const GET_PORTAL_KUDE = Symbol('GetPortalKude');

/** Injection token for the `getPortalSummary` application function. */
export const GET_PORTAL_SUMMARY = Symbol('GetPortalSummary');

/** Injection token for the clock (`() => Date`) the summary measures the 72 h window against; tests replace it. */
export const PORTAL_CLOCK = Symbol('PortalClock');

/** Injection token for the `listAttentionDocuments` application function (HU-E12-04). */
export const LIST_ATTENTION_DOCUMENTS = Symbol('ListAttentionDocuments');
