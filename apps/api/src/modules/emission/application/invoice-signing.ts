import type { DeXmlBuilder, LoadedCertificate, XmlSigner } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import { generateInvoiceXml, InvoiceXmlError, type InvoiceXmlContext } from './invoice-xml.js';

export interface SignedInvoiceXml {
  xml: string;
  /** Instant the signature was produced; persisted with the document. */
  signedAt: Date;
}

const MISSING_QR_GROUP =
  "Element '{http://ekuatia.set.gov.py/sifen/xsd}rDE': Missing child element(s). Expected is ( {http://ekuatia.set.gov.py/sifen/xsd}gCamFuFD ).";

/**
 * Signs the DE through the `XmlSigner` port (XMLDSig enveloped over `<DE>`,
 * RSA-SHA256; the adapter owns KeyInfo and canonicalization, ADR-0015) and
 * checks the signed document against the siRecepDE XSD. The only tolerated
 * error is the missing `gCamFuFD` (the QR group, required after the Signature):
 * the QR embeds the signature digest, so it can only be added after signing
 * (QrGenerator, later slice), which is where the tolerance-free check runs.
 */
export async function signInvoiceXml(
  signer: XmlSigner,
  xml: string,
  material: LoadedCertificate,
  now: () => Date = () => new Date(),
): Promise<SignedInvoiceXml> {
  const signed = await signer.sign(xml, material);
  const signedAt = now();
  const { errors } = validateXml(signed, 'siRecepDE');
  if (errors.length !== 1 || errors[0]?.message !== MISSING_QR_GROUP) {
    throw new InvoiceXmlError(`signed XML: ${errors.map((e) => e.message).join('; ')}`);
  }
  return { xml: signed, signedAt };
}

/** Draft to signed, fully XSD-valid XML: generateInvoiceXml -> signInvoiceXml. */
export async function buildSignedInvoice(
  ports: { builder: DeXmlBuilder; signer: XmlSigner },
  draft: InvoiceDraft,
  ctx: InvoiceXmlContext,
  material: LoadedCertificate,
  now?: () => Date,
): Promise<SignedInvoiceXml & { cdc: string }> {
  const { xml, cdc } = await generateInvoiceXml(ports.builder, draft, ctx);
  return { ...(await signInvoiceXml(ports.signer, xml, material, now)), cdc };
}
