import { describe, expect, it, vi } from 'vitest';

const generateXMLDE = vi.fn();
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
});
