import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import xmlsign from 'facturacionelectronicapy-xmlsign';
import type { LoadedCertificate, XmlSigner } from '@sifen/sifen-gateway';
import { resolveCjsDefault } from './cjs-interop.ts';

interface XmlsignApi {
  signXML(xml: string, file: string, password: string, signByNodeJS: boolean): Promise<string>;
}

const xmlsignApi = resolveCjsDefault(xmlsign) as XmlsignApi;

/**
 * Thin adapter over `facturacionelectronicapy-xmlsign`, Node-mode only
 * (ADR-0015). xmlsign reads the PKCS#12 from a file path, so the in-memory
 * certificate is written to an ephemeral 0600 temp file that is always
 * removed, whether signing succeeds or fails.
 */
export class TipsXmlSigner implements XmlSigner {
  async sign(xml: string, cert: LoadedCertificate): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sifen-cert-'));
    const p12Path = join(dir, `${randomUUID()}.p12`);
    try {
      await writeFile(p12Path, cert.p12, { mode: 0o600 });
      return await xmlsignApi.signXML(xml, p12Path, cert.password, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
