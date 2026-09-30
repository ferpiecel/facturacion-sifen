import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LoadedCertificate, QrGenerator } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import type { FacturaPocInput } from '@sifen/sifen-gateway';
import { pocFacturaInput } from '../../../../test/fixtures/poc-factura-input.js';
import { generateDevCertificate } from '../../../../test/support/dev-certificate.js';
import { computeQrHash } from '../domain/qr.js';
import { addQrToSignedInvoice, InvoiceQrError } from './invoice-qr.js';

const CSC = 'ABCD0000000000000000000000000000';
const OPTIONS = { environment: 'test', idCsc: '0001', csc: CSC } as const;

let signed: string;
let signedExempt: string;
let signedUnnamed: string;
let cert: LoadedCertificate;

async function sign(input: FacturaPocInput): Promise<string> {
  return new TipsXmlSigner().sign(await new TipsDeXmlBuilder().buildParaSifen(input), cert);
}

beforeAll(async () => {
  cert = generateDevCertificate();
  signed = await sign(pocFacturaInput);
  const item = (pocFacturaInput.data.items as Record<string, unknown>[])[0];
  signedExempt = await sign({
    ...pocFacturaInput,
    data: {
      ...pocFacturaInput.data,
      items: [{ ...item, ivaTipo: 3, ivaProporcion: 0, iva: 0 }],
    },
  });
  signedUnnamed = await sign({
    ...pocFacturaInput,
    data: {
      ...pocFacturaInput.data,
      cliente: {
        contribuyente: false,
        razonSocial: 'Sin Nombre',
        tipoOperacion: 2,
        pais: 'PRY',
        paisDescripcion: 'Paraguay',
        documentoTipo: 5,
        documentoNumero: '0',
      },
    },
  });
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
      addQr: (xml, config) => {
        return new TipsQrGenerator()
          .addQr(xml, config)
          .then((out) => out.replace(/dTotGralOpe=\d+/, 'dTotGralOpe=1'));
      },
    };

    const message = await addQrToSignedInvoice(tampered, signed, OPTIONS).then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : ''),
    );

    expect(message).toContain('dTotGralOpe');
    expect(message).not.toContain(CSC);
  });

  it('fails when the generator returns XML that breaks the XSD', async () => {
    const broken: QrGenerator = {
      addQr: (xml) => Promise.resolve(xml.replace('<dVerFor>150', '<dVerFor>x')),
    };

    await expect(addQrToSignedInvoice(broken, signed, OPTIONS)).rejects.toBeInstanceOf(
      InvoiceQrError,
    );
  });

  it('fails when the generator adds no QR at all', async () => {
    const none: QrGenerator = { addQr: vi.fn((xml: string) => Promise.resolve(xml)) };

    await expect(addQrToSignedInvoice(none, signed, OPTIONS)).rejects.toBeInstanceOf(
      InvoiceQrError,
    );
  });

  it('rejects an XML that is not a signed invoice before calling the generator', async () => {
    const addQr = vi.fn<QrGenerator['addQr']>();
    const generator: QrGenerator = { addQr };

    await expect(
      addQrToSignedInvoice(generator, '<rDE><DE/></rDE>', OPTIONS),
    ).rejects.toBeInstanceOf(InvoiceQrError);
    expect(addQr).not.toHaveBeenCalled();
  });

  it('follows the MT for an exempt invoice: dTotIVA=0 and strict XSD', async () => {
    const xml = await addQrToSignedInvoice(new TipsQrGenerator(), signedExempt, OPTIONS);

    expect(validateXml(xml, 'siRecepDE')).toEqual({ valid: true, errors: [] });
    expect(qrOf(xml)).toContain('&amp;dTotIVA=0&amp;');
  });

  it('follows the MT for an unnamed receiver: dNumIDRec=0 and strict XSD', async () => {
    const xml = await addQrToSignedInvoice(new TipsQrGenerator(), signedUnnamed, OPTIONS);

    expect(validateXml(xml, 'siRecepDE')).toEqual({ valid: true, errors: [] });
    expect(qrOf(xml)).toContain('&amp;dNumIDRec=0&amp;');
  });

  it('never echoes the CSC from an XSD error', async () => {
    const leaky: QrGenerator = {
      addQr: (xml, config) =>
        Promise.resolve(xml.replace('<dVerFor>150', `<dVerFor>${config.csc}`)),
    };

    const message = await addQrToSignedInvoice(leaky, signed, OPTIONS).then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : ''),
    );

    expect(message).toContain('Invalid invoice QR');
    expect(message).not.toContain(CSC);
  });
});
