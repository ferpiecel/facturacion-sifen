import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
import {
  ExtractionLlmDisabledError,
  ExtractionLlmInvalidOutputError,
  ExtractionLlmProviderError,
  ExtractionLlmRateLimitedError,
  ExtractionLlmRefusalError,
  type ExtractionLlm,
  type ExtractionLlmRequest,
  type ExtractionLlmResponse,
} from '../../application/ports/extraction-llm.port.js';
import {
  EXTRACTION_OUTPUT_JSON_SCHEMA,
  parseLlmExtractionOutput,
} from '../../domain/extraction-output-schema.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserContent,
} from '../../domain/extraction-prompt.js';
import type { ReceptionExtractionConfig } from '../reception-extraction-config.js';

/** Minimal slice of the SDK client the adapter needs; tests inject a fake. */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(params: MessageCreateParamsNonStreaming): Promise<Message>;
  };
}

/** Generous cap: items arrays are long and thinking models spend tokens before the answer. */
const MAX_TOKENS = 16000;

/** Keywords structured outputs reject (skill: JSON Schema Limitations); validated client-side. */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, value]) => [key, stripUnsupported(value)]),
  );
}

const OUTPUT_SCHEMA = stripUnsupported(EXTRACTION_OUTPUT_JSON_SCHEMA) as Record<string, unknown>;

interface HttpLikeError {
  readonly status?: unknown;
  readonly headers?: unknown;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as HttpLikeError | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function retryAfterSeconds(error: unknown): number | null {
  const headers = (error as HttpLikeError | null)?.headers;
  let raw: unknown;
  if (headers !== null && typeof headers === 'object') {
    const getter = (headers as { get?: unknown }).get;
    raw =
      typeof getter === 'function'
        ? (getter as (name: string) => unknown).call(headers, 'retry-after')
        : (headers as Record<string, unknown>)['retry-after'];
  }
  return typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

/** The configured model id does not exist for this key: another model may still work. */
class ModelUnavailableError extends ExtractionLlmProviderError {}

/** Maps any SDK/network failure to a typed error that never carries provider text. */
function toTypedError(error: unknown): Error {
  if (error instanceof ExtractionLlmDisabledError) return error;
  const status = statusOf(error);
  if (status === 429) return new ExtractionLlmRateLimitedError(retryAfterSeconds(error));
  if (status === 404) return new ModelUnavailableError('HTTP status 404', { retryable: false });
  const retryable = status === undefined || status === 408 || status === 409 || status >= 500;
  return new ExtractionLlmProviderError(
    status === undefined ? 'network or transport error' : `HTTP status ${String(status)}`,
    { retryable },
  );
}

/** A different model may succeed, except for configuration errors that no model can fix. */
function worthFallback(error: unknown): boolean {
  if (
    error instanceof ExtractionLlmRefusalError ||
    error instanceof ExtractionLlmInvalidOutputError ||
    error instanceof ExtractionLlmRateLimitedError
  ) {
    return true;
  }
  if (error instanceof ExtractionLlmProviderError)
    return error.retryable || error instanceof ModelUnavailableError;
  return false;
}

export interface AnthropicExtractionLlmOptions {
  readonly client: AnthropicMessagesClient;
  readonly model: string;
  readonly fallbackModel: string | null;
}

export class AnthropicExtractionLlm implements ExtractionLlm {
  constructor(private readonly options: AnthropicExtractionLlmOptions) {}

  async extract(request: ExtractionLlmRequest): Promise<ExtractionLlmResponse> {
    const { model, fallbackModel } = this.options;
    try {
      return await this.attempt(model, request);
    } catch (error) {
      if (fallbackModel === null || fallbackModel === model || !worthFallback(error)) throw error;
      return this.attempt(fallbackModel, request);
    }
  }

  private async attempt(
    model: string,
    request: ExtractionLlmRequest,
  ): Promise<ExtractionLlmResponse> {
    const content = buildExtractionUserContent(request).map((part) =>
      part.type === 'text'
        ? ({ type: 'text', text: part.text } as const)
        : ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mediaType,
              data: Buffer.from(part.bytes).toString('base64'),
            },
          } as const),
    );
    let message: Message;
    try {
      message = await this.options.client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: [
          { type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        messages: [{ role: 'user', content }],
      });
    } catch (error) {
      throw toTypedError(error);
    }
    return this.read(model, message);
  }

  private read(model: string, message: Message): ExtractionLlmResponse {
    if (message.stop_reason === 'refusal') throw new ExtractionLlmRefusalError();
    if (message.stop_reason === 'max_tokens') {
      throw new ExtractionLlmInvalidOutputError('response truncated at the token limit');
    }
    const block = message.content.find((b) => b.type === 'text');
    if (block?.type !== 'text' || block.text.trim() === '') {
      throw new ExtractionLlmInvalidOutputError('response has no text content');
    }
    const outcome = parseLlmExtractionOutput(block.text);
    if (!outcome.ok) {
      throw new ExtractionLlmInvalidOutputError(`${outcome.error.code}: ${outcome.error.message}`);
    }
    return {
      rawText: block.text,
      modelId: model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

const disabled: ExtractionLlm = {
  extract: () => Promise.reject(new ExtractionLlmDisabledError()),
};

/**
 * The adapter owns the retry policy (one fallback attempt), so the SDK must not retry on its own
 * (its default is 2 retries) and every call is bounded by a finite timeout.
 */
export interface AnthropicClientOptions {
  readonly maxRetries: 0;
  readonly timeout: number;
}

export interface CreateAnthropicExtractionLlmDeps {
  /** Builds the SDK client from the API key and client options; replaced in tests. */
  readonly clientFactory?: (
    apiKey: string,
    options: AnthropicClientOptions,
  ) => AnthropicMessagesClient;
}

/** Builds the adapter, or a stub that raises `ExtractionLlmDisabledError` when no key is set. */
export function createAnthropicExtractionLlm(
  config: Pick<ReceptionExtractionConfig, 'apiKey' | 'model' | 'fallbackModel' | 'timeoutMs'>,
  deps: CreateAnthropicExtractionLlmDeps = {},
): ExtractionLlm {
  if (config.apiKey === null) return disabled;
  const clientFactory =
    deps.clientFactory ??
    ((apiKey: string, options: AnthropicClientOptions) => new Anthropic({ apiKey, ...options }));
  return new AnthropicExtractionLlm({
    client: clientFactory(config.apiKey, { maxRetries: 0, timeout: config.timeoutMs }),
    model: config.model,
    fallbackModel: config.fallbackModel,
  });
}
