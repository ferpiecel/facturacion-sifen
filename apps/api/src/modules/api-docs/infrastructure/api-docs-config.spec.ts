import { describe, expect, it } from 'vitest';
import { isApiDocsEnabled } from './api-docs-config.js';

/** Spec: HU-E5-01. `/docs` is on in development and test, or with the explicit staging flag. */
describe('isApiDocsEnabled', () => {
  it.each(['development', 'test'])('is enabled when NODE_ENV=%s', (nodeEnv) => {
    expect(isApiDocsEnabled({ NODE_ENV: nodeEnv })).toBe(true);
  });

  it.each([undefined, '', 'production', 'staging', 'Development'])(
    'is disabled when NODE_ENV=%s and the flag is unset',
    (nodeEnv) => {
      expect(isApiDocsEnabled({ NODE_ENV: nodeEnv })).toBe(false);
    },
  );

  it('is enabled in production when API_DOCS_ENABLED=true', () => {
    expect(isApiDocsEnabled({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' })).toBe(true);
    expect(isApiDocsEnabled({ API_DOCS_ENABLED: 'true' })).toBe(true);
  });

  it.each(['false', '1', 'TRUE', 'yes', ''])('ignores API_DOCS_ENABLED=%j in production', (flag) => {
    expect(isApiDocsEnabled({ NODE_ENV: 'production', API_DOCS_ENABLED: flag })).toBe(false);
  });
});
