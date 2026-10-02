import type { DeXmlBuilder, QrGenerator, XmlSigner } from '@sifen/sifen-gateway';
import { addQrToSignedInvoice } from './invoice-qr.js';
import { signInvoiceXml } from './invoice-signing.js';
import { generateInvoiceXml } from './invoice-xml.js';
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

/**
 * Signs an `accepted` document (HU-E5-05/06, plan 8.7): opens the tenant's active certificate for
 * the document's environment, builds the DE from the stored data, signs it (dFecFirma in
 * America/Asuncion), adds the QR with the tenant's CSC and checks the final XML against the strict
 * siRecepDE XSD (`addQrToSignedInvoice`). The XML is stored with `accepted -> signed` in a single
 * store call, so any failure before it leaves the document `accepted`. The `.p12` and the CSC only
 * live in memory and are zeroized however the run ends.
 *
 * @throws DocumentNotFoundError, DocumentEnvironmentMismatchError, CscNotConfiguredError,
 *   SigningMismatchError, InvoiceXmlError, InvoiceQrError, and the certificate source's typed
 *   errors (no certificate, expired, not yet valid).
 */
export class SignDocument {
  constructor(private readonly deps: SignDocumentDeps) {}

  async execute({
    tenantId,
    documentId,
  }: {
    readonly tenantId: string;
    readonly documentId: string;
  }): Promise<SignDocumentResult> {
    const document = await this.deps.store.load(tenantId, documentId);
    if (!document) throw new DocumentNotFoundError();
    if (document.status !== 'accepted' || !('context' in document)) {
      return { status: 'skipped', documentStatus: document.status };
    }
    if (document.environment !== document.tenantEnvironment) {
      throw new DocumentEnvironmentMismatchError();
    }

    const certificate = await this.deps.certificates.open(tenantId, document.environment);
    let csc: Awaited<ReturnType<CscSource['get']>> = null;
    try {
      csc = await this.deps.cscs.get(tenantId, document.environment);
      if (!csc) throw new CscNotConfiguredError();

      const unsigned = await generateInvoiceXml(
        this.deps.builder,
        document.draft,
        document.context,
      );
      if (unsigned.cdc !== document.cdc) throw new SigningMismatchError();
      const signed = await signInvoiceXml(this.deps.signer, unsigned.xml, {
        p12: certificate.p12,
        password: certificate.password,
      });
      const signedXml = await addQrToSignedInvoice(this.deps.qr, signed.xml, {
        environment: document.environment,
        idCsc: csc.idCsc,
        csc: csc.value.toString('utf8'),
      });

      const stored = await this.deps.store.markSigned(tenantId, documentId, {
        signedXml,
        signedAt: signed.signedAt,
      });
      return stored
        ? { status: 'signed', cdc: document.cdc, signedAt: signed.signedAt }
        : { status: 'skipped', documentStatus: 'signed' };
    } finally {
      certificate.p12.fill(0);
      csc?.value.fill(0);
    }
  }
}
