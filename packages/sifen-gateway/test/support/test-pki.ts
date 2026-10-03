import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

/** PEM material of a throwaway CA, a localhost server cert and a client cert, all in memory. */
export interface TestPki {
  readonly caCert: string;
  readonly server: { readonly key: string; readonly cert: string };
  readonly client: { readonly key: string; readonly cert: string };
  /** A CA unrelated to the one that signed the other certificates. */
  readonly otherCaCert: string;
}

interface Issued {
  key: string;
  cert: forge.pki.Certificate;
}

function issue(commonName: string, issuer: Issued | undefined, extensions: object[] = []): Issued {
  // Node generates the key quickly; forge only assembles and signs the certificate.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = forge.pki.publicKeyFromPem(
    pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  const signingKey = forge.pki.privateKeyFromPem(issuer?.key ?? keyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e9) + 1);
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600_000);
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer(issuer?.cert.subject.attributes ?? [{ name: 'commonName', value: commonName }]);
  cert.setExtensions(extensions);
  cert.sign(signingKey, forge.md.sha256.create());
  return { key: keyPem, cert };
}

const pem = (cert: forge.pki.Certificate): string => forge.pki.certificateToPem(cert);

export function createTestPki(): TestPki {
  const ca = issue('sifen-test-ca', undefined, [{ name: 'basicConstraints', cA: true }]);
  const other = issue('unrelated-ca', undefined, [{ name: 'basicConstraints', cA: true }]);
  const server = issue('localhost', ca, [
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ]);
  const client = issue('tenant-client', ca);
  return {
    caCert: pem(ca.cert),
    otherCaCert: pem(other.cert),
    server: { key: server.key, cert: pem(server.cert) },
    client: { key: client.key, cert: pem(client.cert) },
  };
}
