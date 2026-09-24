import childProcess from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCertificate } from '@sifen/sifen-gateway';

const { signXML } = vi.hoisted(() => ({ signXML: vi.fn() }));
vi.mock('facturacionelectronicapy-xmlsign', () => ({ default: { signXML } }));

import { TipsXmlSigner } from './xml-signer.ts';

const cert: LoadedCertificate = { p12: new Uint8Array([1, 2, 3]), password: 'secret' };

describe('TipsXmlSigner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    signXML.mockReset();
  });

  it('always signs with signByNodeJS true', async () => {
    signXML.mockResolvedValue('<rDE><Signature/></rDE>');
    const signer = new TipsXmlSigner();

    await signer.sign('<rDE/>', cert);

    expect(signXML).toHaveBeenCalledWith('<rDE/>', expect.any(String), 'secret', true);
  });

  it('deletes the ephemeral cert directory after a successful sign', async () => {
    signXML.mockResolvedValue('<rDE><Signature/></rDE>');
    const signer = new TipsXmlSigner();

    await signer.sign('<rDE/>', cert);

    const p12Path = signXML.mock.calls[0]?.[1] as string;
    await expect(stat(dirname(p12Path))).rejects.toThrow();
  });

  it('deletes the ephemeral cert directory after a failed sign', async () => {
    signXML.mockRejectedValue(new Error('boom'));
    const signer = new TipsXmlSigner();

    await expect(signer.sign('<rDE/>', cert)).rejects.toThrow('boom');

    const p12Path = signXML.mock.calls[0]?.[1] as string;
    await expect(stat(dirname(p12Path))).rejects.toThrow();
  });

  it('never spawns a child process', async () => {
    signXML.mockResolvedValue('<rDE><Signature/></rDE>');
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const execSpy = vi.spyOn(childProcess, 'exec');
    const signer = new TipsXmlSigner();

    await signer.sign('<rDE/>', cert);

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
  });
});
