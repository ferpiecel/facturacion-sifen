import type {
  ExtractionPageImage,
  ExtractionImageMediaType,
} from '../../domain/extraction-prompt.js';

export type { ExtractionPageImage, ExtractionImageMediaType };

export interface ExtractionLlmRequest {
  /** One or more pages of the same document, sent together in a single turn. */
  readonly pages: readonly ExtractionPageImage[];
  /** PDF text layer, when present. */
  readonly pdfText: string | null;
  /** CDC decoded from a QR code, when present. */
  readonly cdcHint: string | null;
}

export interface ExtractionTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface ExtractionLlmResponse {
  /** Raw model text; the caller validates it with `parseLlmExtractionOutput`. */
  readonly rawText: string;
  /** Model that actually produced the answer (primary or fallback). */
  readonly modelId: string;
  readonly usage: ExtractionTokenUsage;
}

/** No API key or the feature is switched off. Not retryable. */
export class ExtractionLlmDisabledError extends Error {
  constructor() {
    super('LLM extraction is disabled or not configured');
    this.name = 'ExtractionLlmDisabledError';
  }
}

/** The model declined to process the document. */
export class ExtractionLlmRefusalError extends Error {
  constructor() {
    super('the model refused to process the document');
    this.name = 'ExtractionLlmRefusalError';
  }
}

/** The provider answered, but without usable text (empty, truncated, no text block). */
export class ExtractionLlmInvalidOutputError extends Error {
  constructor(readonly reason: string) {
    super(`the model returned unusable output: ${reason}`);
    this.name = 'ExtractionLlmInvalidOutputError';
  }
}

/** Network, timeout or upstream failure. Never carries document content. */
export class ExtractionLlmProviderError extends Error {
  readonly retryable: boolean;

  constructor(detail: string, options: { readonly retryable: boolean }) {
    super(`LLM provider failure: ${detail}`);
    this.name = 'ExtractionLlmProviderError';
    this.retryable = options.retryable;
  }
}

export class ExtractionLlmRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number | null = null) {
    super('LLM provider rate limit reached');
    this.name = 'ExtractionLlmRateLimitedError';
  }
}

export interface ExtractionLlm {
  /**
   * Sends the pages (and optional hints) to the model once and returns its raw answer. Adapters may
   * retry on a fallback model internally. Throws only the typed errors above.
   */
  extract(request: ExtractionLlmRequest): Promise<ExtractionLlmResponse>;
}
