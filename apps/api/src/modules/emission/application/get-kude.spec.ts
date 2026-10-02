import { beforeAll, describe, expect, it, vi } from 'vitest';
import { signedInvoiceWithQr } from '../../../../test/support/signed-invoice.js';
import type { KudeInvoice } from '../domain/kude-model.js';
import { createGetKude } from './get-kude.js';
import type { KudeRenderer } from './ports/kude-renderer.port.js';
import type { SignedDocument, SignedXmlReader } from './ports/signed-xml-reader.port.js';

let xml: string;
beforeAll(async () => {
  xml = await signedInvoiceWithQr();
});

const PDF = new Uint8Array([37, 80, 68, 70]);

function setup(found: SignedDocument | null) {
  const findSignedXml = vi.fn<SignedXmlReader['findSignedXml']>(() => Promise.resolve(found));
  const render = vi.fn<KudeRenderer['render']>(() => Promise.resolve(PDF));
  return {
    getKude: createGetKude({ reader: { findSignedXml }, renderer: { render } }),
    findSignedXml,
    render,
  };
}

describe('getKude', () => {
  it('is not found when the reader finds nothing, without rendering', async () => {
    const { getKude, render } = setup(null);
    expect(await getKude('t1', 'd1')).toEqual({ kind: 'not-found' });
    expect(render).not.toHaveBeenCalled();
  });

  it('is not signed while the document has no signed XML', async () => {
    const { getKude, render } = setup({ number: '001-002-0000007', signedXml: null });
    expect(await getKude('t1', 'd1')).toEqual({ kind: 'not-signed' });
    expect(render).not.toHaveBeenCalled();
  });

  it('renders the model read from the signed XML and names the file after the number', async () => {
    const { getKude, findSignedXml, render } = setup({ number: '001-002-0000007', signedXml: xml });
    expect(await getKude('t1', 'd1')).toEqual({
      kind: 'ok',
      pdf: PDF,
      filename: 'kude-001-002-0000007.pdf',
    });
    expect(findSignedXml).toHaveBeenCalledWith('t1', 'd1');
    const model = render.mock.calls[0]?.[0] as KudeInvoice;
    expect(model.cdc).toMatch(/^\d{44}$/);
    expect(model.items).toHaveLength(1);
  });
});
