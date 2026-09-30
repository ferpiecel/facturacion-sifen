import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

/**
 * Throwaway PKI for certificate tests, built entirely in memory. No real PSC
 * root, leaf or `.p12` is ever committed (ADR-0015).
 */
export interface TestAuthority {
  readonly certificate: forge.pki.Certificate;
  readonly privateKey: forge.pki.rsa.PrivateKey;
  readonly pem: string;
}

export interface LeafOptions {
  /** Subject `serialNumber` attribute (persona jurídica), e.g. `RUC80000005-6`. */
  readonly serialNumber?: string;
  /** SAN directoryName `serialNumber` (persona física), e.g. `RUC4490207-7`. */
  readonly sanSerialNumber?: string;
  readonly clientAuth?: boolean;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

export interface TestPkcs12 {
  readonly p12: Buffer;
  readonly password: string;
  /** The tenant (leaf) certificate, PEM-encoded. */
  readonly leafPem: string;
}

const DAY_MS = 86_400_000;
let serial = 1;

function newKeys(): forge.pki.rsa.KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
    publicKey: forge.pki.publicKeyFromPem(publicKey) as forge.pki.rsa.PublicKey,
  };
}

function baseCertificate(publicKey: forge.pki.PublicKey, notBefore: Date, notAfter: Date) {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  serial += 1;
  certificate.serialNumber = serial.toString(16).padStart(2, '0');
  certificate.validity.notBefore = notBefore;
  certificate.validity.notAfter = notAfter;
  return certificate;
}

/** A self-signed CA standing in for a PSC root. */
export function createTestAuthority(commonName: string): TestAuthority {
  const keys = newKeys();
  const now = Date.now();
  const certificate = baseCertificate(
    keys.publicKey,
    new Date(now - DAY_MS),
    new Date(now + 3650 * DAY_MS),
  );
  const subject = [{ name: 'commonName', value: commonName }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return { certificate, privateKey: keys.privateKey, pem: forge.pki.certificateToPem(certificate) };
}

/** A tenant certificate issued by `issuer`, exported as a password-protected `.p12`. */
export function issueTestPkcs12(
  issuer: TestAuthority,
  options: LeafOptions = {},
  password = 'test-p12-password',
): TestPkcs12 {
  const keys = newKeys();
  const now = Date.now();
  const certificate = baseCertificate(
    keys.publicKey,
    options.notBefore ?? new Date(now - DAY_MS),
    options.notAfter ?? new Date(now + 365 * DAY_MS),
  );
  const subject: forge.pki.CertificateField[] = [{ name: 'commonName', value: 'Tenant S.A.' }];
  if (options.serialNumber !== undefined) {
    subject.push({ name: 'serialNumber', value: options.serialNumber });
  }
  certificate.setSubject(subject);
  certificate.setIssuer(issuer.certificate.subject.attributes);
  const extensions: object[] = [{ name: 'keyUsage', digitalSignature: true }];
  extensions.push({
    name: 'extKeyUsage',
    clientAuth: options.clientAuth ?? true,
    emailProtection: true,
  });
  if (options.sanSerialNumber !== undefined) {
    extensions.push({ id: '2.5.29.17', value: sanDirectoryName(options.sanSerialNumber) });
  }
  certificate.setExtensions(extensions);
  certificate.sign(issuer.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [certificate, issuer.certificate],
    password,
    { algorithm: '3des' },
  );
  return {
    p12: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'),
    password,
    leafPem: forge.pki.certificateToPem(certificate),
  };
}

/** `GeneralNames` holding one `directoryName` whose Name has a `serialNumber` (2.5.4.5). */
function sanDirectoryName(value: string): forge.asn1.Asn1 {
  const { asn1 } = forge;
  const attribute = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('2.5.4.5').getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.PRINTABLESTRING, false, value),
  ]);
  const name = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [attribute]),
  ]);
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 4, true, [name]),
  ]);
}
