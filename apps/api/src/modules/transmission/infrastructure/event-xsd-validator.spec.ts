import { describe, expect, it } from 'vitest';
import { validateEventXml } from './event-xsd-validator.js';
describe('validateEventXml', () => {
  it('validates a bare event group under the SIFEN namespace, as the gateway will send it', () => {
    const result = validateEventXml(
      '<gGroupGesEve xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>',
    );

    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/rGesEve/);
  });

  it('does not repeat a namespace the event already carries', () => {
    const result = validateEventXml(
      '<gGroupGesEve xmlns="http://ekuatia.set.gov.py/sifen/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>',
    );

    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/rGesEve/);
    expect(result.errors.map((e) => e.message).join('\n')).not.toMatch(/redefin|Attribute|parse/i);
  });

  it('rejects what is not an event group', () => {
    expect(validateEventXml('<rDE/>').valid).toBe(false);
  });
});
