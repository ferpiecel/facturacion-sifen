import { describe, expect, it } from 'vitest';
import { emissionValidationConfig, signingValidationConfig } from './emission-validation-config.js';

describe('emission validation configs (HU-E5-08)', () => {
  it('checks the receiver geography when a document is accepted', () => {
    const config = emissionValidationConfig();

    expect(config.validateGeo).toBe(true);
    expect(config.geoCatalog?.city(3383)).toEqual({
      code: 3383,
      districtCode: 145,
      name: 'CIUDAD DEL ESTE',
    });
  });

  it('keeps the catalog but not its checks when signing, so earlier accepted documents still sign', () => {
    const config = signingValidationConfig();

    expect(config.validateGeo).toBe(false);
    expect(config.geoCatalog).toBe(emissionValidationConfig().geoCatalog);
    expect(config.allowDecimals).toBe(emissionValidationConfig().allowDecimals);
  });
});
