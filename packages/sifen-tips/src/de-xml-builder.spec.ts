import { describe, expect, it, vi } from 'vitest';

const { generateXMLDE } = vi.hoisted(() => ({ generateXMLDE: vi.fn() }));
vi.mock('facturacionelectronicapy-xmlgen', () => ({ default: { generateXMLDE } }));

import { TipsDeXmlBuilder } from './de-xml-builder.ts';

describe('TipsDeXmlBuilder', () => {
  it('forwards params and data to xmlgen and returns its XML', async () => {
    generateXMLDE.mockResolvedValue('<rDE/>');
    const builder = new TipsDeXmlBuilder();

    const result = await builder.buildParaSifen({ params: { a: 1 }, data: { b: 2 } });

    expect(generateXMLDE).toHaveBeenCalledWith({ a: 1 }, { b: 2 });
    expect(result).toBe('<rDE/>');
  });

  it('passes the xmlgen options only when the input carries them', async () => {
    generateXMLDE.mockClear();
    generateXMLDE.mockResolvedValue('<rDE/>');
    const builder = new TipsDeXmlBuilder();

    await builder.buildParaSifen({ params: {}, data: {}, config: { pygDecimals: 8 } });
    await builder.buildParaSifen({ params: {}, data: {} });

    expect(generateXMLDE).toHaveBeenNthCalledWith(1, {}, {}, { pygDecimals: 8 });
    expect(generateXMLDE).toHaveBeenNthCalledWith(2, {}, {});
  });

  describe('xmlgen console output', () => {
    it('keeps what xmlgen logs (the seller location of an AFE) out of stdout and restores console', async () => {
      const original = console.log;
      const spy = vi.fn();
      console.log = spy;
      try {
        generateXMLDE.mockImplementation(() => {
          console.log({ ubicacion: 'Calle 1' });
          return Promise.resolve('<rDE/>');
        });
        const builder = new TipsDeXmlBuilder();
        await builder.buildParaSifen({ params: {}, data: {} });
        expect(spy).not.toHaveBeenCalled();
        expect(console.log).toBe(spy);
      } finally {
        console.log = original;
      }
    });

    it('restores console even when xmlgen throws and across concurrent builds', async () => {
      const original = console.log;
      const spy = vi.fn();
      console.log = spy;
      try {
        generateXMLDE.mockRejectedValueOnce(new Error('boom'));
        generateXMLDE.mockResolvedValueOnce('<rDE/>');
        const builder = new TipsDeXmlBuilder();
        const results = await Promise.allSettled([
          builder.buildParaSifen({ params: {}, data: {} }),
          builder.buildParaSifen({ params: {}, data: {} }),
        ]);
        expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
        expect(console.log).toBe(spy);
      } finally {
        console.log = original;
      }
    });
  });
});
