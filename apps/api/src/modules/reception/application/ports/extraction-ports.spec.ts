import { describe, expect, it } from 'vitest';
import {
  ExtractionLlmDisabledError,
  ExtractionLlmInvalidOutputError,
  ExtractionLlmProviderError,
  ExtractionLlmRateLimitedError,
  ExtractionLlmRefusalError,
} from './extraction-llm.port.js';
import { CorruptPdfError, EmptyPdfError, TooManyPagesError } from './pdf-renderer.port.js';

describe('extraction LLM errors', () => {
  it('are distinguishable by class and name', () => {
    const errors = [
      new ExtractionLlmDisabledError(),
      new ExtractionLlmRefusalError(),
      new ExtractionLlmInvalidOutputError('no text block'),
      new ExtractionLlmProviderError('upstream 500', { retryable: true }),
      new ExtractionLlmRateLimitedError(30),
    ];
    expect(new Set(errors.map((e) => e.name)).size).toBe(5);
    expect(errors.every((e) => e instanceof Error)).toBe(true);
  });

  it('carry retry hints without leaking content', () => {
    expect(new ExtractionLlmRateLimitedError(30).retryAfterSeconds).toBe(30);
    expect(new ExtractionLlmRateLimitedError().retryAfterSeconds).toBeNull();
    expect(new ExtractionLlmProviderError('boom', { retryable: false }).retryable).toBe(false);
  });
});

describe('PDF renderer errors', () => {
  it('describe the page limit', () => {
    const error = new TooManyPagesError(12, 5);
    expect(error.pageCount).toBe(12);
    expect(error.maxPages).toBe(5);
    expect(error.message).toContain('12');
  });

  it('are distinct classes', () => {
    expect(new CorruptPdfError()).not.toBeInstanceOf(EmptyPdfError);
    expect(new EmptyPdfError().name).toBe('EmptyPdfError');
  });
});
