import type { TenantEnvironment } from '../../../fiscal-config/domain/document-environment.js';
import type { InvoiceDraft } from '../../domain/invoice-draft.js';
import type { InvoiceXmlContext } from '../invoice-xml.js';

/** An accepted document with everything needed to build its XML (rebuilt from the stored payload). */
export interface SignableDocument {
  readonly documentId: string;
  readonly cdc: string;
  readonly status: string;
  /** Environment the document was accepted in. */
  readonly environment: TenantEnvironment;
  /** The tenant's environment right now; signing a document of another one is refused. */
  readonly tenantEnvironment: TenantEnvironment;
  readonly draft: InvoiceDraft;
  readonly context: InvoiceXmlContext;
}

/** A document that is not `accepted`: nothing to sign, so nothing else is loaded or parsed. */
export interface NotAcceptedDocument {
  readonly documentId: string;
  readonly status: string;
}

export interface SigningStore {
  /**
   * Runs inside the tenant's RLS scope; null when the document does not exist for the tenant. A
   * document that is not `accepted` comes back as {@link NotAcceptedDocument} (no `context`).
   */
  load(
    tenantId: string,
    documentId: string,
  ): Promise<SignableDocument | NotAcceptedDocument | null>;
  /**
   * One tenant transaction: stores `signed_xml`/`signed_at` and moves `accepted -> signed`.
   * False (nothing written) when the document is no longer `accepted`.
   */
  markSigned(
    tenantId: string,
    documentId: string,
    signed: { readonly signedXml: string; readonly signedAt: Date },
  ): Promise<boolean>;
}

/** The tenant's active certificate in memory; the service zeroizes `p12` after use. */
export interface SigningCertificate {
  readonly p12: Buffer;
  readonly password: string;
}

export interface CertificateSource {
  /** @throws a typed error when there is no valid active certificate (e.g. CertificateVault's). */
  open(tenantId: string, environment: TenantEnvironment): Promise<SigningCertificate>;
}

export interface CscSecret {
  readonly idCsc: string;
  /** Plaintext; the service zeroizes it after use. */
  readonly value: Buffer;
}

export interface CscSource {
  /** Null when the tenant has no CSC for the environment. */
  get(tenantId: string, environment: TenantEnvironment): Promise<CscSecret | null>;
}

/** The stored document lacks data the DE needs (e.g. receiver address, item descriptions). */
export class SigningDataIncompleteError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`document data incomplete for signing: ${missing.join(', ')}`);
    this.name = 'SigningDataIncompleteError';
  }
}

/** gEmis requires dTelEmi and dEmailE; the document's establishment has none (see `establishment:contact`). */
export class EstablishmentContactMissingError extends Error {
  constructor(readonly establishmentCode: string) {
    super(`establishment ${establishmentCode} has no phone/email (dTelEmi/dEmailE)`);
    this.name = 'EstablishmentContactMissingError';
  }
}
