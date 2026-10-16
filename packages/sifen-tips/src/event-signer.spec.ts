import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCertificate } from '@sifen/sifen-gateway';

const { signXMLEvento } = vi.hoisted(() => ({ signXMLEvento: vi.fn() }));
vi.mock('facturacionelectronicapy-xmlsign', () => ({ default: { signXMLEvento } }));

import { TipsEventSigner } from './event-signer.ts';

const cert: LoadedCertificate = { p12: new Uint8Array([1, 2, 3]), password: 'secret' };
const EVENT =
  '<gGroupGesEve xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rGesEve><rEve Id="7"><dVerFor>150</dVerFor></rEve></rGesEve></gGroupGesEve>';
const SIGNED_GROUP = EVENT.replace('</rEve>', '</rEve><Signature>sig</Signature>');
const echoSigned = (xml: string): string =>
  `<?xml version="1.0"?>${xml.replace('</rEve>', '</rEve><Signature>sig</Signature>')}`;

describe('TipsEventSigner', () => {
  afterEach(() => {
    signXMLEvento.mockReset();
  });

  it('signs in Node mode the event wrapped in the envelope the library expects', async () => {
    signXMLEvento.mockImplementation((xml: string) => Promise.resolve(echoSigned(xml)));

    await new TipsEventSigner().sign(EVENT, cert);

    const [sent, path, password, nodeMode] = signXMLEvento.mock.calls[0] as [
      string,
      string,
      string,
      boolean,
    ];
    expect(sent).toContain('<rEnviEventoDe xmlns="http://ekuatia.set.gov.py/sifen/xsd">');
    expect(sent).toContain(`<dEvReg>${EVENT}</dEvReg>`);
    expect(path).toMatch(/\.p12$/);
    expect(password).toBe('secret');
    expect(nodeMode).toBe(true);
  });

  it('returns only the signed event group, not the envelope', async () => {
    signXMLEvento.mockImplementation((xml: string) => Promise.resolve(echoSigned(xml)));

    const signed = await new TipsEventSigner().sign(EVENT, cert);

    expect(signed).toBe(SIGNED_GROUP);
  });

  it('fails when the library returns no event group', async () => {
    signXMLEvento.mockResolvedValue('<env:Envelope/>');

    await expect(new TipsEventSigner().sign(EVENT, cert)).rejects.toThrow(/event group/);
  });

  it('refuses an event that is not a bare event group', async () => {
    await expect(new TipsEventSigner().sign('<rDE/>', cert)).rejects.toThrow(/gGroupGesEve/);
    expect(signXMLEvento).not.toHaveBeenCalled();
  });

  it('deletes the ephemeral cert directory after a successful and a failed sign', async () => {
    signXMLEvento.mockImplementation((xml: string) => Promise.resolve(echoSigned(xml)));
    await new TipsEventSigner().sign(EVENT, cert);
    const okPath = signXMLEvento.mock.calls[0]?.[1] as string;
    await expect(stat(dirname(okPath))).rejects.toThrow();

    signXMLEvento.mockRejectedValue(new Error('boom'));
    await expect(new TipsEventSigner().sign(EVENT, cert)).rejects.toThrow('boom');
    const failedPath = signXMLEvento.mock.calls[1]?.[1] as string;
    await expect(stat(dirname(failedPath))).rejects.toThrow();
  });
});
