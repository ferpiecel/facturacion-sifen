import { describe, expect, it } from 'vitest';
import { loadReceptionExtractionConfig } from './reception-extraction-config.js';

describe('loadReceptionExtractionConfig', () => {
  it('uses documented defaults and reports a missing key as disabled, not as an error', () => {
    expect(loadReceptionExtractionConfig({})).toEqual({
      apiKey: null,
      model: 'claude-sonnet-5',
      fallbackModel: 'claude-haiku-4-5',
      autoConfirmThreshold: 0.85,
      timeoutMs: 120_000,
      concurrency: 2,
    });
  });

  it('treats a blank key as disabled', () => {
    expect(loadReceptionExtractionConfig({ ANTHROPIC_API_KEY: '   ' }).apiKey).toBeNull();
  });

  it('reads every variable and trims it', () => {
    expect(
      loadReceptionExtractionConfig({
        ANTHROPIC_API_KEY: ' sk-ant-test-key ',
        RECEPTION_EXTRACTION_MODEL: ' model-a ',
        RECEPTION_EXTRACTION_FALLBACK_MODEL: 'model-b',
        RECEPTION_AUTO_CONFIRM_THRESHOLD: '0.9',
      }),
    ).toEqual({
      apiKey: 'sk-ant-test-key',
      model: 'model-a',
      fallbackModel: 'model-b',
      autoConfirmThreshold: 0.9,
      timeoutMs: 120_000,
      concurrency: 2,
    });
  });

  it.each(['none', 'OFF', ' None '])('opts out of the fallback with %j', (value) => {
    const config = loadReceptionExtractionConfig({ RECEPTION_EXTRACTION_FALLBACK_MODEL: value });
    expect(config.fallbackModel).toBeNull();
  });

  it('reads the request timeout in milliseconds', () => {
    const config = loadReceptionExtractionConfig({ RECEPTION_EXTRACTION_TIMEOUT_MS: ' 30000 ' });
    expect(config.timeoutMs).toBe(30_000);
  });

  it.each(['999', '600001', '1.5', 'abc', '-1', '1e3'])(
    'rejects timeout %s and names the variable',
    (value) => {
      expect(() =>
        loadReceptionExtractionConfig({ RECEPTION_EXTRACTION_TIMEOUT_MS: value }),
      ).toThrow('RECEPTION_EXTRACTION_TIMEOUT_MS');
    },
  );

  it('reads the worker concurrency', () => {
    expect(
      loadReceptionExtractionConfig({ RECEPTION_EXTRACTION_CONCURRENCY: ' 4 ' }).concurrency,
    ).toBe(4);
  });

  it.each(['0', '9', '1.5', 'abc', '-1'])('rejects concurrency %s and names the variable', (v) => {
    expect(() => loadReceptionExtractionConfig({ RECEPTION_EXTRACTION_CONCURRENCY: v })).toThrow(
      'RECEPTION_EXTRACTION_CONCURRENCY',
    );
  });

  it('falls back to the defaults for blank model variables', () => {
    const config = loadReceptionExtractionConfig({
      RECEPTION_EXTRACTION_MODEL: '',
      RECEPTION_EXTRACTION_FALLBACK_MODEL: ' ',
    });
    expect(config.model).toBe('claude-sonnet-5');
    expect(config.fallbackModel).toBe('claude-haiku-4-5');
  });

  it.each(['0', '1', '0.5', '1.0', '0.85'])('accepts threshold %s', (value) => {
    const config = loadReceptionExtractionConfig({ RECEPTION_AUTO_CONFIRM_THRESHOLD: value });
    expect(config.autoConfirmThreshold).toBe(Number(value));
  });

  it.each(['-0.1', '1.01', '2', 'abc', '0,85', '1e-1', 'NaN', 'Infinity', '.5', '0x1'])(
    'rejects threshold %s and names the variable',
    (value) => {
      expect(() =>
        loadReceptionExtractionConfig({ RECEPTION_AUTO_CONFIRM_THRESHOLD: value }),
      ).toThrow('RECEPTION_AUTO_CONFIRM_THRESHOLD');
    },
  );

  it.each(['bad model', 'a'.repeat(129), 'model\nid', 'm"x'])(
    'rejects a malformed model id without echoing it: %j',
    (value) => {
      let message = '';
      try {
        loadReceptionExtractionConfig({ RECEPTION_EXTRACTION_MODEL: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('RECEPTION_EXTRACTION_MODEL');
      expect(message).not.toContain(value);
    },
  );

  it('rejects a malformed fallback model id', () => {
    expect(() =>
      loadReceptionExtractionConfig({ RECEPTION_EXTRACTION_FALLBACK_MODEL: 'no good' }),
    ).toThrow('RECEPTION_EXTRACTION_FALLBACK_MODEL');
  });

  it('never leaks the API key in an error', () => {
    try {
      loadReceptionExtractionConfig({
        ANTHROPIC_API_KEY: 'sk-ant-SECRET',
        RECEPTION_AUTO_CONFIRM_THRESHOLD: 'x',
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET');
    }
  });
});
