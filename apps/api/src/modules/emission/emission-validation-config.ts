import type { ValidationConfig } from './domain/invoice-draft.js';

/**
 * The one `ValidationConfig` of the emission flow. The API acceptance path and the worker signing
 * path both read it here, so a draft the API accepted is never rejected when the worker signs it.
 * HU-E5-09: `allowDecimals` is the switch; turning it on is a deliberate change made in this file
 * (or its environment source) after the Prevalidador confirms the decimal rules (T1, ADR-0018).
 */
export function emissionValidationConfig(): ValidationConfig {
  return { allowDecimals: false };
}
