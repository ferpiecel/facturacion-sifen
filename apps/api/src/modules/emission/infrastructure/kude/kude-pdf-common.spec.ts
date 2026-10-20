import { describe, expect, it } from 'vitest';
import { PT_PER_MM, renderQr, sanitize } from './kude-pdf-common.js';

const CDC = '01800695631001001000000612021112917595714694';
const QR_URL = `https://ekuatia.set.gov.py/consultas-test/qr?nVersion=150&Id=${CDC}&dFeEmiDE=313230&cHashQR=abc`;

describe('sanitize', () => {
  it('keeps Latin text, accents and the guaraní sign, turns whitespace controls into spaces', () => {
    expect(sanitize('Belén\tBosco\n₲ 1')).toBe('Belén Bosco ₲ 1');
  });

  it('replaces what the font cannot draw with "?"', () => {
    expect(sanitize('a\u{1F600}b')).toBe('a?b');
  });
});

describe('renderQr', () => {
  it('prints at least 25 mm wide (MT v150 13.8.1) as a PNG', async () => {
    const qr = await renderQr({ qrUrl: QR_URL } as Parameters<typeof renderQr>[0]);
    expect(qr.size).toBeGreaterThanOrEqual(25 * PT_PER_MM);
    expect(qr.png.subarray(1, 4).toString()).toBe('PNG');
  });
});
