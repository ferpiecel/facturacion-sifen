import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import forge from 'node-forge';
import {
  inspectCertificate,
  Pkcs12ContentError,
  Pkcs12UnreadableError,
  type CertificateInspection,
} from '../domain/tenant-certificate.js';

/**
 * Opens a tenant `.p12` in memory (node:crypto has no PKCS#12 reader, so
 * node-forge only unpacks the container) and inspects the certificate that
 * matches its private key. The key never leaves this function.
 *
 * @throws Pkcs12UnreadableError on a wrong password or malformed bytes.
 * @throws Pkcs12ContentError unless it holds exactly one key and its certificate.
 */
export function inspectPkcs12(p12: Uint8Array, password: string): CertificateInspection {
  const { keys, certificates } = openPkcs12(p12, password);
  if (keys.length !== 1) {
    throw new Pkcs12ContentError('PKCS#12 must hold exactly one private key');
  }
  const [key] = keys;
  const leaf = certificates.find((certificate) => certificate.checkPrivateKey(key));
  if (leaf === undefined) {
    throw new Pkcs12ContentError('PKCS#12 holds no certificate for its private key');
  }
  return inspectCertificate(
    leaf,
    certificates.filter((certificate) => certificate !== leaf),
  );
}

function openPkcs12(
  p12: Uint8Array,
  password: string,
): { keys: KeyObject[]; certificates: X509Certificate[] } {
  try {
    const der = forge.util.createBuffer(Buffer.from(p12).toString('binary'));
    const pfx = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), true, password);
    const keyBags = [
      ...(pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
        forge.pki.oids.pkcs8ShroudedKeyBag
      ] ?? []),
      ...(pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
    ];
    const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
    return {
      keys: keyBags.flatMap((bag) =>
        bag.key ? [createPrivateKey(forge.pki.privateKeyToPem(bag.key))] : [],
      ),
      certificates: certBags.flatMap((bag) =>
        bag.cert ? [new X509Certificate(toDer(forge.pki.certificateToAsn1(bag.cert)))] : [],
      ),
    };
  } catch {
    // The cause is dropped on purpose: forge diagnostics may describe the secret.
    throw new Pkcs12UnreadableError();
  }
}

function toDer(asn1: forge.asn1.Asn1): Buffer {
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}
