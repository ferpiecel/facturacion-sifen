/** The signed DE of a stored document (HU-E6-02 persists it while signing). */
export interface SignedDocument {
  /** `est-point-number`, e.g. `001-002-0000007`. */
  number: string;
  environment: 'test' | 'production';
  /** Null until the document is signed. */
  signedXml: string | null;
}

/** Tenant-scoped: another tenant's document, an unknown one or one of another environment is `null`. */
export interface SignedXmlReader {
  findSignedXml(tenantId: string, id: string): Promise<SignedDocument | null>;
}
