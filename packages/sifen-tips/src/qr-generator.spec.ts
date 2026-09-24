import { describe, expect, it, vi } from 'vitest';

const { generateQR } = vi.hoisted(() => ({ generateQR: vi.fn() }));
vi.mock('facturacionelectronicapy-qrgen', () => ({ default: { generateQR } }));

import { TipsQrGenerator } from './qr-generator.ts';

describe('TipsQrGenerator', () => {
  it('forwards idCsc and csc and maps the test ambiente to the qrgen env', async () => {
    generateQR.mockResolvedValue('<rDE><gCamFuFD/></rDE>');
    const generator = new TipsQrGenerator();

    const result = await generator.addQr('<rDE><Signature/></rDE>', {
      idCsc: '0001',
      csc: 'CSC-SECRET',
      ambiente: 'test',
    });

    expect(generateQR).toHaveBeenCalledWith(
      '<rDE><Signature/></rDE>',
      '0001',
      'CSC-SECRET',
      'test',
    );
    expect(result).toBe('<rDE><gCamFuFD/></rDE>');
  });

  it('maps the prod ambiente to the qrgen prod env', async () => {
    generateQR.mockResolvedValue('<rDE/>');
    const generator = new TipsQrGenerator();

    await generator.addQr('<rDE><Signature/></rDE>', {
      idCsc: '0001',
      csc: 'CSC-SECRET',
      ambiente: 'prod',
    });

    expect(generateQR).toHaveBeenCalledWith(
      '<rDE><Signature/></rDE>',
      '0001',
      'CSC-SECRET',
      'prod',
    );
  });
});
