import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import forge from 'node-forge';
import {
  inspectCertificate,
  Pkcs12ContentError,
  Pkcs12UnreadableError,
  type CertificateInspection,
} from '../domain/tenant-certificate.js';
import { DerError } from '../domain/der.js';

/**
 * A tenant `.p12` holds one key, its certificate and a short PSC chain,
 * usually 3 to 10 KiB; 64 KiB leaves room for long chains while bounding
 * the synchronous ASN.1 parsing an upload can trigger.
 */
export const MAX_PKCS12_BYTES = 64 * 1024;

/**
 * Upper bound for any MAC, PKCS#12 PBE or PBKDF2 iteration count. Common
 * values are 2048 (OpenSSL's PKCS12_DEFAULT_ITER) and 10000 (Java keytool's
 * default); forge derives keys in pure, synchronous JavaScript, so 100000
 * keeps a legitimate file around a second while a hostile count cannot
 * block the event loop.
 */
export const MAX_KDF_ITERATIONS = 100_000;

/**
 * Budget for one parse, since a small file can hold many encrypted bags. A
 * standard `.p12` derives at most 5 keys (MAC, then key and IV for the
 * certificate SafeContents and for the key bag), so 8 calls and 5 times the
 * per-call cap (500000 iterations, about a second of forge) admit any
 * legitimate file while bounding the event-loop time of a hostile one.
 */
export const MAX_KEY_DERIVATIONS = 8;
export const MAX_TOTAL_KDF_ITERATIONS = 5 * MAX_KDF_ITERATIONS;

/** Leaf plus chain; also bounds the chain search in the domain. */
export const MAX_PKCS12_CERTIFICATES = 10;

/**
 * Opens a tenant `.p12` in memory (node:crypto has no PKCS#12 reader, so
 * node-forge only unpacks the container) and inspects the certificate that
 * matches its private key. The key never leaves this function.
 *
 * @throws Pkcs12UnreadableError on a wrong password or malformed bytes,
 *   including certificate DER the domain cannot parse.
 * @throws Pkcs12ContentError when the file is too large or too costly to
 *   open, or does not hold exactly one RSA key with its certificate.
 */
export function inspectPkcs12(p12: Uint8Array, password: string): CertificateInspection {
  if (p12.length > MAX_PKCS12_BYTES) {
    throw new Pkcs12ContentError('too-large', 'PKCS#12 exceeds 64 KiB');
  }
  const { keys, certificates } = openPkcs12(p12, password);
  if (certificates.length > MAX_PKCS12_CERTIFICATES) {
    throw new Pkcs12ContentError('too-many-certificates', 'PKCS#12 holds too many certificates');
  }
  const [key] = keys;
  if (keys.length !== 1) {
    throw new Pkcs12ContentError('key-count', 'PKCS#12 must hold exactly one private key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    // §8.7: SIFEN signatures are RSA-SHA256 (RSA 2048, or 4096 in hardware).
    throw new Pkcs12ContentError('unsupported-key-algorithm', 'only RSA keys are supported');
  }
  const leaf = certificates.find((certificate) => certificate.checkPrivateKey(key));
  if (leaf === undefined) {
    throw new Pkcs12ContentError(
      'no-matching-certificate',
      'PKCS#12 holds no certificate for its private key',
    );
  }
  try {
    return inspectCertificate(
      leaf,
      certificates.filter((certificate) => certificate !== leaf),
    );
  } catch (error) {
    // A leaf whose DER extensions do not parse is a malformed file.
    if (error instanceof DerError) throw new Pkcs12UnreadableError();
    throw error;
  }
}

function openPkcs12(
  p12: Uint8Array,
  password: string,
): { keys: KeyObject[]; certificates: X509Certificate[] } {
  try {
    return withKdfIterationLimit(() => {
      const der = forge.util.createBuffer(Buffer.from(p12).toString('binary'));
      const pfx = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), true, password);
      const bags = (bagType: string) => pfx.getBags({ bagType })[bagType] ?? [];
      const { oids } = forge.pki;
      return {
        // forge only decodes RSA; other algorithms come back as raw ASN.1,
        // which node:crypto parses so they are reported rather than dropped.
        keys: [...bags(oids.pkcs8ShroudedKeyBag), ...bags(oids.keyBag)].flatMap((bag) => {
          if (bag.key) return [createPrivateKey(forge.pki.privateKeyToPem(bag.key))];
          const raw = undecoded(bag);
          if (raw) return [createPrivateKey({ key: toDer(raw), format: 'der', type: 'pkcs8' })];
          return [];
        }),
        certificates: bags(oids.certBag).flatMap((bag) => {
          const asn1 = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : undecoded(bag);
          return asn1 ? [new X509Certificate(toDer(asn1))] : [];
        }),
      };
    });
  } catch (error) {
    if (error instanceof Pkcs12ContentError) throw error;
    // The cause is dropped on purpose: forge diagnostics may describe the secret.
    throw new Pkcs12UnreadableError();
  }
}

/** The raw ASN.1 forge keeps (despite its typing) only for a bag it could not decode. */
function undecoded(bag: forge.pkcs12.Bag): forge.asn1.Asn1 | undefined {
  return (bag as { asn1?: forge.asn1.Asn1 }).asn1;
}

function toDer(asn1: forge.asn1.Asn1): Buffer {
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

type KeyDerivation = (...args: unknown[]) => unknown;
type KdfOwner = Record<string, KeyDerivation>;

/**
 * forge reads iteration counts from the (attacker-supplied) file and runs
 * them synchronously. This wraps its three key-derivation entry points (MAC
 * key, PKCS#12 PBE and PBKDF2) so a count above {@link MAX_KDF_ITERATIONS}
 * is refused before any work starts, including counts nested inside
 * encrypted SafeContents that no ASN.1 pre-parse can see. The wrap lives
 * only for this synchronous call and is always restored, so no other code
 * can observe it.
 */
function withKdfIterationLimit<T>(run: () => T): T {
  // Counters are per call of this function, never shared between parses.
  const hooks: [KdfOwner, string, number][] = [
    [forge.pkcs12 as unknown as KdfOwner, 'generateKey', 3],
    [(forge.pki as unknown as { pbe: KdfOwner }).pbe, 'generatePkcs12Key', 3],
    [forge.pkcs5 as unknown as KdfOwner, 'pbkdf2', 2],
  ];
  const originals = hooks.map(([owner, name]) => owner[name]);
  let derivations = 0;
  let totalIterations = 0;
  hooks.forEach(([owner, name, countIndex], index) => {
    const original = originals[index];
    owner[name] = (...args: unknown[]) => {
      const count = args[countIndex];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count > MAX_KDF_ITERATIONS) {
        throw new Pkcs12ContentError('excessive-iterations', 'PKCS#12 iteration count too high');
      }
      derivations += 1;
      totalIterations += count;
      if (derivations > MAX_KEY_DERIVATIONS || totalIterations > MAX_TOTAL_KDF_ITERATIONS) {
        throw new Pkcs12ContentError(
          'excessive-key-derivations',
          'PKCS#12 needs too many key derivations',
        );
      }
      return original(...args);
    };
  });
  try {
    return run();
  } finally {
    hooks.forEach(([owner, name], index) => {
      owner[name] = originals[index];
    });
  }
}
