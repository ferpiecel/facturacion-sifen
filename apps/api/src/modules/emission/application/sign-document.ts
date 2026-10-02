import type { DeXmlBuilder, QrGenerator, XmlSigner } from '@sifen/sifen-gateway';
import type { CertificateSource, CscSource, SigningStore } from './ports/signing.port.js';

export class DocumentNotFoundError extends Error {
  constructor() {
    super('document not found');
    this.name = 'DocumentNotFoundError';
  }
}

/** The tenant switched environment after the document was accepted; it must not be signed with the other one's certificate. */
export class DocumentEnvironmentMismatchError extends Error {
  constructor() {
    super('document environment differs from the tenant environment');
    this.name = 'DocumentEnvironmentMismatchError';
  }
}

export class CscNotConfiguredError extends Error {
  constructor() {
    super('no CSC configured for the tenant environment');
    this.name = 'CscNotConfiguredError';
  }
}

/** The generated XML does not belong to the stored document (its CDC differs). */
export class SigningMismatchError extends Error {
  constructor() {
    super('generated DE does not match the stored document');
    this.name = 'SigningMismatchError';
  }
}

export interface SignDocumentDeps {
  readonly store: SigningStore;
  readonly certificates: CertificateSource;
  readonly cscs: CscSource;
  readonly builder: DeXmlBuilder;
  readonly signer: XmlSigner;
  readonly qr: QrGenerator;
}

export type SignDocumentResult =
  | { readonly status: 'signed'; readonly cdc: string; readonly signedAt: Date }
  /** Nothing to do: the document is not (or no longer) `accepted`. */
  | { readonly status: 'skipped'; readonly documentStatus: string };

export class SignDocument {
  constructor(private readonly deps: SignDocumentDeps) {}

  execute(_input: {
    readonly tenantId: string;
    readonly documentId: string;
  }): Promise<SignDocumentResult> {
    return Promise.reject(new Error('not implemented'));
  }
}
