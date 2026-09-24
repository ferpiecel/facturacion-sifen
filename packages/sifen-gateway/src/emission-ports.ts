/**
 * Framework-free emission ports for the offline TIPS PoC (HU-E0-04).
 *
 * Implementations MUST NOT import NestJS, Fastify, Drizzle, BullMQ, or any
 * `facturacionelectronicapy-*` (TIPS) library. Only `@sifen/sifen-tips`
 * adapters may depend on the TIPS libraries directly (see the root
 * `.dependency-cruiser.cjs` rule).
 */

/** SIFEN target environment. */
export type Ambiente = 'test' | 'prod';

/** A certificate loaded in memory as a PKCS#12 bundle, never written to disk. */
export interface LoadedCertificate {
  readonly p12: Uint8Array;
  readonly password: string;
}

/** Configuration needed to embed the SIFEN QR in a signed DE. */
export interface QrConfig {
  readonly idCsc: string;
  readonly csc: string;
  readonly ambiente: Ambiente;
}

/**
 * Opaque, domain-free input for the offline PoC builder. Replaced by the
 * full `DocumentoElectronico` domain model in E5.
 */
export interface FacturaPocInput {
  readonly params: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Builds a signable FE XML document from PoC-level DE data. */
export interface DeXmlBuilder {
  buildParaSifen(input: FacturaPocInput): Promise<string>;
}

/** Signs an FE XML document. Implementations MUST NOT spawn a JVM process. */
export interface XmlSigner {
  sign(xml: string, cert: LoadedCertificate): Promise<string>;
}

/** Embeds the SIFEN QR in a signed FE XML document. */
export interface QrGenerator {
  addQr(signedXml: string, config: QrConfig): Promise<string>;
}
