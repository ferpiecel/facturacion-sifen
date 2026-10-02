import type { FacturaPocInput } from '@sifen/sifen-gateway';
import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import { addQrToSignedInvoice } from '../../src/modules/emission/application/invoice-qr.js';
import { pocFacturaInput } from '../fixtures/poc-factura-input.js';
import { generateDevCertificate } from './dev-certificate.js';

export const TEST_CSC = 'ABCD0000000000000000000000000000';

/** Real pipeline output: TIPS builder -> XMLDSig signature -> QR (verified by `addQrToSignedInvoice`). */
export async function signedInvoiceWithQr(
  patch: (input: FacturaPocInput) => FacturaPocInput = (input) => input,
): Promise<string> {
  const signed = await new TipsXmlSigner().sign(
    await new TipsDeXmlBuilder().buildParaSifen(patch(pocFacturaInput)),
    generateDevCertificate(),
  );
  return addQrToSignedInvoice(new TipsQrGenerator(), signed, {
    environment: 'test',
    idCsc: '0001',
    csc: TEST_CSC,
  });
}

/** The same invoice with its only item exempt from VAT. */
export const exemptItem = (input: FacturaPocInput): FacturaPocInput => {
  const item = (input.data.items as Record<string, unknown>[])[0];
  return {
    ...input,
    data: { ...input.data, items: [{ ...item, ivaTipo: 3, ivaProporcion: 0, iva: 0 }] },
  };
};

/** The same invoice for an unnamed receiver (innominado). */
export const unnamedReceiver = (input: FacturaPocInput): FacturaPocInput => ({
  ...input,
  data: {
    ...input.data,
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
