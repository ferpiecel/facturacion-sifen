import forge from 'node-forge';
import type { MtlsCredential } from '@sifen/sifen-gateway';
import { MAX_PKCS12_BYTES } from './pkcs12-inspector.js';
import { Pkcs12ContentError, Pkcs12UnreadableError } from '../domain/tenant-certificate.js';

/**
 * Converts a tenant `.p12` into the PEM key and certificate chain the mTLS transport needs (the
 * leaf first, then the rest of the file). Pure and in memory: the caller owns the result, must not
 * log or persist it and keeps it only for the call that needs it. forge, not OpenSSL, opens the
 * container so legacy PSC encryption (3DES/RC2) keeps working on Node 22.
 * @throws Pkcs12UnreadableError wrong password or malformed bytes (the cause is dropped on purpose)
 * @throws Pkcs12ContentError too large, or no key with a matching certificate
 */
export function pkcs12ToMtlsCredential(p12: Uint8Array, password: string): MtlsCredential {
  if (p12.length > MAX_PKCS12_BYTES)
    throw new Pkcs12ContentError('too-large', 'PKCS#12 exceeds 64 KiB');
  let key: forge.pki.rsa.PrivateKey | undefined;
  let certificates: forge.pki.Certificate[];
  try {
    const der = forge.util.createBuffer(Buffer.from(p12).toString('binary'));
    const pfx = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), true, password);
    const bags = (bagType: string) => pfx.getBags({ bagType })[bagType] ?? [];
    const { oids } = forge.pki;
    key = [...bags(oids.pkcs8ShroudedKeyBag), ...bags(oids.keyBag)].at(0)?.key;
    certificates = bags(oids.certBag).flatMap((bag) => (bag.cert ? [bag.cert] : []));
  } catch {
    throw new Pkcs12UnreadableError();
  }
  const modulus = (key as { n?: { toString(radix: number): string } } | undefined)?.n?.toString(16);
  const leaf = certificates.find(
    (certificate) =>
      (certificate.publicKey as { n?: { toString(radix: number): string } }).n?.toString(16) ===
      modulus,
  );
  if (key === undefined || modulus === undefined || leaf === undefined) {
    throw new Pkcs12ContentError(
      'no-matching-certificate',
      'PKCS#12 holds no certificate for its private key',
    );
  }
  const chain = [leaf, ...certificates.filter((certificate) => certificate !== leaf)];
  return {
    key: forge.pki.privateKeyToPem(key),
    cert: chain.map((certificate) => forge.pki.certificateToPem(certificate)).join(''),
  };
}
