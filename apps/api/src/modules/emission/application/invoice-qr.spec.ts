import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoadedCertificate, QrGenerator } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import { pocFacturaInput } from '../../../../../../packages/sifen-tips/test/fixtures/poc-factura-input.ts';
import { generateDevCertificate } from '../../../../test/support/dev-certificate.js';
import { computeQrHash } from '../domain/qr.js';
import { addQrToSignedInvoice, InvoiceQrError } from './invoice-qr.js';

const CSC = 'ABCD0000000000000000000000000000';
const OPTIONS = { environment: 'test', idCsc: '0001', csc: CSC } as const;

let signed: string;

beforeAll(async () => {
  const cert: LoadedCertificate = generateDevCertificate();
  const xml = await new TipsDeXmlBuilder().buildParaSifen(pocFacturaInput);
  signed = await new TipsXmlSigner().sign(xml, cert);
});

function qrOf(xml: string): string {
  return /<dCarQR>([^<]*)<\/dCarQR>/.exec(xml)?.[1] ?? '';
}

describe('addQrToSignedInvoice', () => {
  it('adds a QR that passes the strict XSD and our independent verification', async () => {
    const xml = await addQrToSignedInvoice(new TipsQrGenerator(), signed, OPTIONS);

    expect(validateXml(xml, 'siRecepDE')).toEqual({ valid: true, errors: [] });
    expect(qrOf(xml)).toContain('https://ekuatia.set.gov.py/consultas-test/qr?');
  });

  it('matches our own cHashQR computation for the adapter output', async () => {
    const xml = await addQrToSignedInvoice(new TipsQrGenerator(), signed, OPTIONS);
    const url = qrOf(xml).replaceAll('&amp;', '&');
    const [params, hash] = url.split('?')[1].split('&cHashQR=');

    expect(hash).toBe(computeQrHash(params, CSC));
  });

  it('uses the production URL for the production environment', async () => {
    const xml = await addQrToSignedInvoice(new TipsQrGenerator(), signed, {
      ...OPTIONS,
      environment: 'production',
    });

    expect(qrOf(xml)).toContain('https://ekuatia.set.gov.py/consultas/qr?');
    expect(qrOf(xml)).not.toContain('consultas-test');
  });

  it('never leaves the CSC in the XML', async () => {
    const xml = await addQrToSignedInvoice(new TipsQrGenerator(), signed, OPTIONS);

    expect(xml).not.toContain(CSC);
  });

  it('fails without leaking the CSC when the generator output is wrong', async () => {
    const tampered: QrGenerator = {
      addQr: async (xml, config) => {
        const out = await new TipsQrGenerator().addQr(xml, config);
        return out.replace(/dTotGralOpe=\d+/, 'dTotGralOpe=1');
      },
    };

    const error = await addQrToSignedInvoice(tampered, signed, OPTIONS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvoiceQrError);
    expect((error as Error).message).toContain('dTotGralOpe');
    expect((error as Error).message).not.toContain(CSC);
  });

  it('fails when the generator returns XML that breaks the XSD', async () => {
    const broken: QrGenerator = { addQr: async (xml) => xml.replace('<dVerFor>150', '<dVerFor>x') };

    await expect(addQrToSignedInvoice(broken, signed, OPTIONS)).rejects.toBeInstanceOf(
      InvoiceQrError,
    );
  });

  it('fails when the generator adds no QR at all', async () => {
    const none: QrGenerator = { addQr: vi.fn(async (xml: string) => xml) };

    await expect(addQrToSignedInvoice(none, signed, OPTIONS)).rejects.toBeInstanceOf(
      InvoiceQrError,
    );
  });

  it('rejects an XML that is not a signed invoice before calling the generator', async () => {
    const generator: QrGenerator = { addQr: vi.fn() };

    await expect(
      addQrToSignedInvoice(generator, '<rDE><DE/></rDE>', OPTIONS),
    ).rejects.toBeInstanceOf(InvoiceQrError);
    expect(generator.addQr).not.toHaveBeenCalled();
  });
});
