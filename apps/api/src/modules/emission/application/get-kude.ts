import { readKudeInvoice } from './kude-reader.js';
import type { KudeRenderer } from './ports/kude-renderer.port.js';
import type { SignedXmlReader } from './ports/signed-xml-reader.port.js';

export type KudeResult =
  | { kind: 'not-found' }
  /** The document exists but is not signed yet: there is nothing to print. */
  | { kind: 'not-signed' }
  | { kind: 'ok'; pdf: Uint8Array; filename: string };

/** HU-E10-01: the KuDE of a tenant's signed document, rendered on demand from its signed XML. */
export function createGetKude(deps: { reader: SignedXmlReader; renderer: KudeRenderer }) {
  return async (tenantId: string, id: string): Promise<KudeResult> => {
    const found = await deps.reader.findSignedXml(tenantId, id);
    if (!found) return { kind: 'not-found' };
    if (found.signedXml === null) return { kind: 'not-signed' };
    const pdf = await deps.renderer.render(readKudeInvoice(found.signedXml));
    return { kind: 'ok', pdf, filename: `kude-${found.number}.pdf` };
  };
}
