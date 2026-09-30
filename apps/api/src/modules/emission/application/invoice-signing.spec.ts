import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LoadedCertificate } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { TipsDeXmlBuilder, TipsXmlSigner } from '@sifen/sifen-tips';
import { createEstablishment } from '../../fiscal-config/domain/establishment.js';
import { createExpeditionPoint } from '../../fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../../fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../../fiscal-config/domain/ruc.js';
import { createTimbrado } from '../../fiscal-config/domain/timbrado.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import type { InvoiceXmlContext } from './invoice-xml.js';
import { buildSignedInvoice, signInvoiceXml } from './invoice-signing.js';
import { InvoiceXmlError, generateInvoiceXml } from './invoice-xml.js';

const PASSWORD = 'throwaway-test-password';
const SIGNED_AT = new Date('2026-09-30T13:00:05Z');

/** Throwaway self-signed certificate (RUC in the subject serialNumber, as DNIT issues them). */
function throwawayMaterial(): { material: LoadedCertificate; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [
    { name: 'commonName', value: 'EMPRESA REAL SA' },
    { name: 'countryName', value: 'PY' },
    { name: 'serialNumber', value: 'RUC80000001-3' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1
    .toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, PASSWORD, { algorithm: '3des' }))
    .getBytes();
  return {
    material: { p12: Uint8Array.from(der, (c) => c.charCodeAt(0)), password: PASSWORD },
    certPem: forge.pki.certificateToPem(cert),
  };
}

const draft: InvoiceDraft = {
  receiver: { kind: 'named', isPublicEntity: false },
  operationType: 'B2B',
  items: [{ quantity: 2, unitPrice: 5000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

const context: InvoiceXmlContext = {
  environment: 'production',
  issuer: createFiscalProfile({
    ruc: parseRuc('80000001-3'),
    legalName: 'Empresa Real SA',
    tradeName: 'Empresa Real',
    taxpayerType: 'persona_juridica',
    regimeCode: '8',
    economicActivities: [{ code: '1254', description: 'Desarrollo de Software' }],
  }),
  establishment: createEstablishment({
    code: '001',
    address: 'Calle Falsa',
    houseNumber: '123',
    departmentCode: 11,
    districtCode: '145',
    districtDescription: 'CIUDAD DEL ESTE',
    cityCode: '3432',
    cityDescription: 'PUERTO PTE.STROESSNER (MUNIC)',
  }),
  establishmentContact: { phone: '0973-000000', email: 'emisor@test.com', name: 'Casa Matriz' },
  point: createExpeditionPoint({ code: '001' }),
  timbrado: createTimbrado({ number: '12345678', validityStart: '2024-01-01' }),
  numbering: { documentNumber: '0000001', securityCode: '298398000' },
  issuedAt: new Date('2026-09-30T13:00:00Z'),
  receiver: {
    ruc: '80000002-7',
    name: 'Receptor Prueba SA',
    address: 'Avda Prueba',
    houseNumber: '100',
    districtCode: 143,
    districtDescription: 'DOMINGO MARTINEZ DE IRALA',
    cityCode: 3344,
    cityDescription: 'PASO ITA (INDIGENA)',
  },
  lines: [{ code: 'A-001', description: 'Servicio real uno', unitCode: 77 }],
};

const builder = new TipsDeXmlBuilder();
const signer = new TipsXmlSigner();

describe('HU-E5-05 invoice signing', () => {
  let material: LoadedCertificate;
  let certPem: string;
  let unsigned: { xml: string; cdc: string };

  beforeAll(async () => {
    ({ material, certPem } = throwawayMaterial());
    unsigned = await generateInvoiceXml(builder, draft, context);
  });

  it('signs the DE and returns the signature instant; the full XSD passes with no tolerance', async () => {
    const result = await signInvoiceXml(signer, unsigned.xml, material, () => SIGNED_AT);

    expect(result.signedAt).toEqual(SIGNED_AT);
    expect(validateXml(result.xml, 'siRecepDE').errors).toEqual([]);
  });

  it('builds an enveloped RSA-SHA256 signature over #CDC whose digest and value verify', async () => {
    const { xml } = await signInvoiceXml(signer, unsigned.xml, material, () => SIGNED_AT);
    const signatureXml = xml.match(/<Signature[\s\S]*?<\/Signature>/)?.[0] ?? '';

    expect(signatureXml).toContain(`<Reference URI="#${unsigned.cdc}"`);
    expect(signatureXml).toContain('http://www.w3.org/2000/09/xmldsig#enveloped-signature');
    expect(signatureXml).toContain('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
    expect(signatureXml).toContain('http://www.w3.org/2001/04/xmlenc#sha256');
    const sig = new SignedXml({ publicCert: certPem });
    sig.loadSignature(signatureXml);
    expect(sig.checkSignature(xml)).toBe(true);
  });

  it('carries KeyInfo with X509Certificate only (NT 016: no X509IssuerSerial)', async () => {
    const { xml } = await signInvoiceXml(signer, unsigned.xml, material, () => SIGNED_AT);
    const keyInfo = xml.match(/<KeyInfo[\s\S]*?<\/KeyInfo>/)?.[0] ?? '';

    expect(keyInfo).toContain('<X509Certificate>');
    expect(keyInfo).not.toContain('X509IssuerSerial');
  });

  it('fails when a tampered DE breaks the full XSD check', async () => {
    const tamperingSigner = {
      sign: async (xml: string, cert: LoadedCertificate) =>
        (await signer.sign(xml, cert)).replace('<dVerFor>150</dVerFor>', '<dVerFor>x</dVerFor>'),
    };

    await expect(signInvoiceXml(tamperingSigner, unsigned.xml, material)).rejects.toBeInstanceOf(
      InvoiceXmlError,
    );
  });

  it('buildSignedInvoice chains generate -> sign -> full validation', async () => {
    const result = await buildSignedInvoice(
      { builder, signer },
      draft,
      context,
      material,
      () => SIGNED_AT,
    );

    expect(result.cdc).toBe(unsigned.cdc);
    expect(result.signedAt).toEqual(SIGNED_AT);
    expect(result.xml).toContain(`Id="${unsigned.cdc}"`);
    expect(result.xml).toContain('<Signature');
  });
});
