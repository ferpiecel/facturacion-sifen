import forge from 'node-forge';
import type { LoadedCertificate } from '@sifen/sifen-gateway';

const DEV_CERT_SUBJECT = [
  { name: 'commonName', value: 'sifen-tips-poc-dev' },
  { name: 'countryName', value: 'PY' },
] satisfies forge.pki.CertificateField[];

const DEV_CERT_PASSWORD = 'poc-offline-dev-password';
const RSA_KEY_BITS = 2048;
const CERT_VALIDITY_YEARS = 1;

/**
 * Generates a self-signed RSA-2048 development certificate entirely in
 * memory and exports it as PKCS#12 (ADR-0015: nothing is written to disk
 * by this function, and no `.p12` fixture is ever committed).
 */
export function generateDevCertificate(): LoadedCertificate {
  const keys = forge.pki.rsa.generateKeyPair(RSA_KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CERT_VALIDITY_YEARS);
  cert.setSubject(DEV_CERT_SUBJECT);
  cert.setIssuer(DEV_CERT_SUBJECT);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, DEV_CERT_PASSWORD, {
    algorithm: '3des',
  });
  const p12Bytes = forge.asn1.toDer(p12Asn1).getBytes();
  const p12 = Uint8Array.from(p12Bytes, (char) => char.charCodeAt(0));

  return { p12, password: DEV_CERT_PASSWORD };
}
