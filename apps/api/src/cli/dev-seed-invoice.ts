import forge from 'node-forge';
import type { FacturaPocInput } from '@sifen/sifen-gateway';
import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import { DEMO_ISSUER } from './dev-seed-issuer.js';
import { addQrToSignedInvoice } from '../modules/emission/application/invoice-qr.js';

/** Public example CSC from the SIFEN docs: the same one the tests use, never a real secret. */
const DEMO_CSC = 'ABCD0000000000000000000000000000';
const DEMO_P12_PASSWORD = 'demo-offline-dev-password';
const SUBJECT = [
  { name: 'commonName', value: 'sifen-demo-dev' },
] satisfies forge.pki.CertificateField[];

/** A self-signed RSA-2048 PKCS#12 generated in memory; it is only used to sign demo XML. */
export function generateDemoCertificate(): { p12: Uint8Array; password: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject(SUBJECT);
  cert.setIssuer(SUBJECT);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1
    .toDer(
      forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, DEMO_P12_PASSWORD, { algorithm: '3des' }),
    )
    .getBytes();
  return { p12: Uint8Array.from(der, (char) => char.charCodeAt(0)), password: DEMO_P12_PASSWORD };
}

const input = (numero: number, receiverName: string): FacturaPocInput => ({
  params: {
    version: 150,
    ruc: DEMO_ISSUER.ruc,
    razonSocial: DEMO_ISSUER.legalName,
    nombreFantasia: DEMO_ISSUER.legalName,
    actividadesEconomicas: [{ codigo: '62010', descripcion: 'Programación informática' }],
    timbradoNumero: DEMO_ISSUER.timbrado,
    timbradoFecha: DEMO_ISSUER.timbradoFrom,
    tipoContribuyente: 2,
    tipoRegimen: 8,
    establecimientos: [
      {
        codigo: DEMO_ISSUER.establishment,
        direccion: 'Calle Falsa 123',
        numeroCasa: '0',
        complementoDireccion1: '',
        complementoDireccion2: '',
        departamento: 11,
        departamentoDescripcion: 'ALTO PARANA',
        distrito: 145,
        distritoDescripcion: 'CIUDAD DEL ESTE',
        ciudad: 3432,
        ciudadDescripcion: 'PUERTO PTE.STROESSNER (MUNIC)',
        telefono: '0973-000000',
        email: 'demo@example.com',
        denominacion: 'Casa Matriz',
      },
    ],
  },
  data: {
    tipoDocumento: 1,
    establecimiento: DEMO_ISSUER.establishment,
    codigoSeguridadAleatorio: String(298000 + numero),
    punto: DEMO_ISSUER.point,
    numero: String(numero).padStart(7, '0'),
    descripcion: 'Documento de demostración sin valor comercial ni fiscal',
    observacion: '',
    fecha: '2026-09-30T10:00:00',
    tipoEmision: 1,
    tipoTransaccion: 1,
    tipoImpuesto: 1,
    moneda: 'PYG',
    condicionAnticipo: 1,
    condicionTipoCambio: 1,
    descuentoGlobal: 0,
    anticipoGlobal: 0,
    cambio: 0,
    cliente: {
      contribuyente: true,
      ruc: '80000002-7',
      razonSocial: receiverName,
      nombreFantasia: receiverName,
      tipoOperacion: 1,
      direccion: 'Avda Prueba 100',
      numeroCasa: '100',
      departamento: 11,
      departamentoDescripcion: 'ALTO PARANA',
      distrito: 143,
      distritoDescripcion: 'DOMINGO MARTINEZ DE IRALA',
      ciudad: 3344,
      ciudadDescripcion: 'PASO ITA (INDIGENA)',
      pais: 'PRY',
      paisDescripcion: 'Paraguay',
      tipoContribuyente: 1,
      documentoTipo: 1,
      documentoNumero: '80000002',
      telefono: '061-000000',
      celular: '0973-000000',
      email: 'receptor@example.com',
      codigo: '0001',
    },
    usuario: { documentoTipo: 1, documentoNumero: '1', nombre: 'Usuario Demo', cargo: 'Vendedor' },
    factura: { presencia: 1 },
    condicion: { tipo: 1, entregas: [{ tipo: 1, monto: '11000', moneda: 'PYG', cambio: 0 }] },
    items: [
      {
        codigo: 'A-001',
        descripcion: 'Servicio de demostración',
        unidadMedida: 77,
        cantidad: 1,
        precioUnitario: 10000,
        cambio: 0,
        descuento: 0,
        anticipo: 0,
        pais: 'PRY',
        paisDescripcion: 'Paraguay',
        ivaTipo: 1,
        ivaProporcion: 100,
        iva: 10,
      },
    ],
  },
});

export interface DemoInvoice {
  xml: string;
  cdc: string;
}

/** The real pipeline output (TIPS builder, XMLDSig, QR) for demo invoice number `numero`. */
export async function buildSignedDemoInvoice(
  certificate: { p12: Uint8Array; password: string },
  numero: number,
  receiverName: string,
): Promise<DemoInvoice> {
  const signed = await new TipsXmlSigner().sign(
    await new TipsDeXmlBuilder().buildParaSifen(input(numero, receiverName)),
    certificate,
  );
  const xml = await addQrToSignedInvoice(new TipsQrGenerator(), signed, {
    environment: 'test',
    idCsc: '0001',
    csc: DEMO_CSC,
  });
  const cdc = /<DE\b[^>]*\bId="(\d{44})"/.exec(xml)?.[1];
  if (!cdc) throw new Error('the demo invoice has no CDC');
  return { xml, cdc };
}
