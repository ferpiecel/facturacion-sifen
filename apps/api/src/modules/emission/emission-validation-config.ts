import { loadGeoCatalog } from '@sifen/sifen-xsd';
import { createGeoCatalog } from '../geo/domain/geo-catalog.js';
import type { ValidationConfig } from './domain/invoice-draft.js';

let geoCatalog: ReturnType<typeof createGeoCatalog> | undefined;
const catalog = () => (geoCatalog ??= createGeoCatalog(loadGeoCatalog()));

/**
 * The `ValidationConfig` of the API acceptance path.
 * HU-E5-09: `allowDecimals` is the switch; turning it on is a deliberate change made in this file
 * (or its environment source) after the Prevalidador confirms the decimal rules (T1, ADR-0018).
 * HU-E5-08: the receiver's district and city are checked against the DNIT catalog (1325, 1329).
 */
export function emissionValidationConfig(): ValidationConfig {
  return { allowDecimals: false, geoCatalog: catalog(), validateGeo: true };
}

/**
 * The worker's signing config: same rules, except the catalog checks. A document accepted before
 * they existed must still sign; the XML carries the catalog text either way (`geoCatalog`).
 */
export function signingValidationConfig(): ValidationConfig {
  return { ...emissionValidationConfig(), validateGeo: false };
}
