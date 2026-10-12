/** Portal type codes and the SIFEN `iTiDE` (C002) they map to: FE 1, AFE 4, NCE 5, NDE 6. */
const TYPE_CODES = { FE: 1, AFE: 4, NCE: 5, NDE: 6 } as const;

export type PortalDocumentType = keyof typeof TYPE_CODES;

export const PORTAL_DOCUMENT_TYPES = Object.keys(TYPE_CODES) as PortalDocumentType[];

export function documentTypeCode(type: PortalDocumentType): number {
  return TYPE_CODES[type];
}

/** `null` for an `iTiDE` the portal has no code for (export, import, remision, transport). */
export function portalDocumentType(code: number): PortalDocumentType | null {
  return PORTAL_DOCUMENT_TYPES.find((type) => TYPE_CODES[type] === code) ?? null;
}
