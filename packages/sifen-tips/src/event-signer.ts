import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import xmlsign from 'facturacionelectronicapy-xmlsign';
import type { EventSigner, LoadedCertificate } from '@sifen/sifen-gateway';
import { resolveCjsDefault } from './cjs-interop.ts';

interface XmlsignEventApi {
  signXMLEvento(
    xml: string,
    file: string,
    password: string,
    signByNodeJS: boolean,
  ): Promise<string>;
}

const xmlsignApi = resolveCjsDefault(xmlsign) as XmlsignEventApi;

const SIFEN_NS = 'http://ekuatia.set.gov.py/sifen/xsd';
const EVENT_GROUP = /<gGroupGesEve[\s\S]*<\/gGroupGesEve>/;

/** `signXMLEvento` only understands the envelope the event generator produces, so the event is wrapped in one. */
const envelopeOf = (eventXml: string): string =>
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Header/><env:Body>' +
  `<rEnviEventoDe xmlns="${SIFEN_NS}"><dId>1</dId><dEvReg>${eventXml}</dEvReg></rEnviEventoDe>` +
  '</env:Body></env:Envelope>';

/**
 * Thin adapter over `facturacionelectronicapy-xmlsign` for events, Node mode only (ADR-0015). Like
 * `TipsXmlSigner`, the in-memory certificate goes to an ephemeral 0600 temp file that is always removed.
 * The signature is computed over `rEve` and placed after it; the envelope is thrown away, and the batch
 * envelope the gateway builds restores the same default namespace, so the digest still verifies.
 */
export class TipsEventSigner implements EventSigner {
  async sign(eventXml: string, cert: LoadedCertificate): Promise<string> {
    if (!eventXml.startsWith('<gGroupGesEve')) {
      throw new Error('Only a bare gGroupGesEve event can be signed');
    }
    if (eventXml.split('<gGroupGesEve').length !== 2) {
      throw new Error('Exactly one gGroupGesEve event can be signed at a time');
    }
    const dir = await mkdtemp(join(tmpdir(), 'sifen-cert-'));
    const p12Path = join(dir, `${randomUUID()}.p12`);
    try {
      await writeFile(p12Path, cert.p12, { mode: 0o600 });
      const signed = await xmlsignApi.signXMLEvento(
        envelopeOf(eventXml),
        p12Path,
        cert.password,
        true,
      );
      const group = EVENT_GROUP.exec(signed)?.[0];
      if (!group) throw new Error('The signed result holds no event group');
      return group;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
