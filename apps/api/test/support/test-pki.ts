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

export interface AuthorityOptions {
  /** Issuing CA; omitted for a self-signed root. */
  readonly issuer?: TestAuthority;
  /** basicConstraints cA flag (default true). */
  readonly ca?: boolean;
  readonly pathLength?: number;
  /** Reuses another authority's key pair (a cross-certificate). */
  readonly keysFrom?: TestAuthority;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

/** One SAN GeneralName; `directorySerialNumber` is a directoryName with a serialNumber. */
export interface TestGeneralName {
  readonly type: 'directorySerialNumber' | 'email' | 'dns' | 'uri' | 'otherName';
  readonly value: string;
}

export interface LeafOptions {
  /** Subject `serialNumber` attribute (persona jurídica), e.g. `RUC80000005-6`. */
  readonly serialNumber?: string;
  /** SubjectAltName entries (persona física carries the RUC in a directoryName). */
  readonly san?: readonly TestGeneralName[];
  readonly clientAuth?: boolean;
  /** Leaves out the extended key usage extension entirely. */
  readonly omitExtendedKeyUsage?: boolean;
  /** keyUsage digitalSignature bit (default true). */
  readonly digitalSignature?: boolean;
  /** Leaves out the keyUsage extension entirely. */
  readonly omitKeyUsage?: boolean;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  /** Extra certificates bundled in the `.p12` (default: the issuer). */
  readonly bundle?: readonly TestAuthority[];
  /** PKCS#12 protection (default: 3DES, 2048 iterations, with MAC). */
  readonly pkcs12?: {
    readonly algorithm?: '3des' | 'aes256';
    readonly count?: number;
    readonly useMac?: boolean;
  };
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
    privateKey: forge.pki.privateKeyFromPem(privateKey),
    publicKey: forge.pki.publicKeyFromPem(publicKey),
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

/** A CA standing in for a PSC root (self-signed) or, given an `issuer`, an intermediate. */
export function createTestAuthority(
  commonName: string,
  options: AuthorityOptions = {},
): TestAuthority {
  const { issuer, keysFrom } = options;
  const keys = keysFrom
    ? {
        privateKey: keysFrom.privateKey,
        publicKey: keysFrom.certificate.publicKey as forge.pki.rsa.PublicKey,
      }
    : newKeys();
  const now = Date.now();
  const certificate = baseCertificate(
    keys.publicKey,
    options.notBefore ?? new Date(now - DAY_MS),
    options.notAfter ?? new Date(now + 3650 * DAY_MS),
  );
  const subject = [{ name: 'commonName', value: commonName }];
  certificate.setSubject(subject);
  certificate.setIssuer(issuer?.certificate.subject.attributes ?? subject);
  certificate.setExtensions([
    {
      name: 'basicConstraints',
      cA: options.ca ?? true,
      ...(options.pathLength === undefined ? {} : { pathLenConstraint: options.pathLength }),
      critical: true,
    },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  certificate.sign(issuer?.privateKey ?? keys.privateKey, forge.md.sha256.create());
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
  const extensions: object[] = [];
  if (options.omitKeyUsage !== true) {
    extensions.push({
      name: 'keyUsage',
      digitalSignature: options.digitalSignature ?? true,
      keyEncipherment: true,
    });
  }
  if (options.omitExtendedKeyUsage !== true) {
    extensions.push({
      name: 'extKeyUsage',
      clientAuth: options.clientAuth ?? true,
      emailProtection: true,
    });
  }
  if (options.san !== undefined) {
    extensions.push({ id: '2.5.29.17', value: generalNames(options.san) });
  }
  certificate.setExtensions(extensions);
  certificate.sign(issuer.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [certificate, ...(options.bundle ?? [issuer]).map((authority) => authority.certificate)],
    password,
    { algorithm: '3des', ...options.pkcs12 },
  );
  return {
    p12: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'),
    password,
    leafPem: forge.pki.certificateToPem(certificate),
  };
}

const { asn1 } = forge;

function derString(type: number, value: string): forge.asn1.Asn1 {
  return asn1.create(asn1.Class.UNIVERSAL, type, false, value);
}

function oid(value: string): forge.asn1.Asn1 {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(value).getBytes());
}

/** A `Name` with a single `serialNumber` (2.5.4.5) attribute. */
function serialNumberName(value: string): forge.asn1.Asn1 {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        oid('2.5.4.5'),
        derString(asn1.Type.PRINTABLESTRING, value),
      ]),
    ]),
  ]);
}

function generalName({ type, value }: TestGeneralName): forge.asn1.Asn1 {
  const context = (tag: number, constructed: boolean, content: string | forge.asn1.Asn1[]) =>
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag, constructed, content);
  switch (type) {
    case 'directorySerialNumber':
      return context(4, true, [serialNumberName(value)]);
    case 'email':
      return context(1, false, value);
    case 'dns':
      return context(2, false, value);
    case 'uri':
      return context(6, false, value);
    case 'otherName':
      return context(0, true, [
        oid('1.3.6.1.4.1.311.20.2.3'),
        context(0, true, [derString(asn1.Type.UTF8, value)]),
      ]);
  }
}

/** DER `GeneralNames` for a subjectAltName extension value. */
function generalNames(names: readonly TestGeneralName[]): forge.asn1.Asn1 {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, names.map(generalName));
}
