import { describe, expect, it, vi } from 'vitest';
import { RECEIVED_FIELD_NAMES } from '../../domain/confidence-policy.js';
import { EXTRACTION_SYSTEM_PROMPT } from '../../domain/extraction-prompt.js';
import {
  ExtractionLlmDisabledError,
  ExtractionLlmInvalidOutputError,
  ExtractionLlmProviderError,
  ExtractionLlmRateLimitedError,
  ExtractionLlmRefusalError,
  type ExtractionLlmRequest,
} from '../../application/ports/extraction-llm.port.js';
import {
  AnthropicExtractionLlm,
  createAnthropicExtractionLlm,
  type AnthropicMessagesClient,
} from './anthropic-extraction-llm.adapter.js';

const confidences = Object.fromEntries(RECEIVED_FIELD_NAMES.map((n) => [n, 0.9]));
const validJson = JSON.stringify({
  cdc: null,
  issuerRuc: '80000000-3',
  issuerLegalName: 'Almacen Don Jose',
  documentNumber: '002-001-0014228',
  issueDate: '2026-01-27',
  receiverRuc: null,
  paymentCondition: 'cash',
  totals: null,
  items: [],
  fieldConfidences: confidences,
  overallConfidence: 0.9,
  notes: null,
});

const request: ExtractionLlmRequest = {
  pages: [
    { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
    { bytes: new Uint8Array([4, 5]), mediaType: 'image/jpeg' },
  ],
  pdfText: 'text layer',
  cdcHint: null,
};

interface FakeMessage {
  stop_reason: string;
  content: unknown[];
  usage?: Record<string, number | null>;
}

const okMessage = (text = validJson, over: Partial<FakeMessage> = {}): FakeMessage => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 5,
  },
  ...over,
});

class HttpError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly headers?: unknown,
  ) {
    super('upstream said: secret document text');
  }
}

function fakeClient(...outcomes: (FakeMessage | Error)[]) {
  const create = vi.fn((): Promise<unknown> => {
    const next = outcomes.shift();
    if (next === undefined) throw new Error('unexpected extra call');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { client: { messages: { create } } as unknown as AnthropicMessagesClient, create };
}

const build = (client: AnthropicMessagesClient, fallbackModel: string | null = 'fallback-model') =>
  new AnthropicExtractionLlm({ client, model: 'primary-model', fallbackModel });

type CallParams = {
  model: string;
  system: { type: string; text: string; cache_control?: unknown }[];
  output_config?: { format?: { type: string; schema: Record<string, unknown> } };
  messages: { role: string; content: Record<string, unknown>[] }[];
};
const firstCall = (create: ReturnType<typeof fakeClient>['create'], index = 0): CallParams =>
  (create.mock.calls[index] as unknown as [CallParams])[0];

describe('AnthropicExtractionLlm.extract', () => {
  it('returns raw text, the model used and mapped usage', async () => {
    const { client } = fakeClient(okMessage());
    const response = await build(client).extract(request);
    expect(response.rawText).toBe(validJson);
    expect(response.modelId).toBe('primary-model');
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 5,
    });
  });

  it('maps null cache counters to zero', async () => {
    const { client } = fakeClient(
      okMessage(validJson, {
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
    );
    const { usage } = await build(client).extract(request);
    expect(usage.cacheReadInputTokens).toBe(0);
    expect(usage.cacheCreationInputTokens).toBe(0);
  });

  it('marks the system prompt with ephemeral cache control', async () => {
    const { client, create } = fakeClient(okMessage());
    await build(client).extract(request);
    const call = firstCall(create);
    expect(call.system).toEqual([
      { type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    expect(call.model).toBe('primary-model');
  });

  it('sends pages as base64 image blocks with their media type, then the text parts', async () => {
    const { client, create } = fakeClient(okMessage());
    await build(client).extract(request);
    const content = firstCall(create).messages[0]?.content ?? [];
    const images = content.filter((part) => part['type'] === 'image');
    expect(images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BAU=' } },
    ]);
    expect(
      content.some((p) => p['type'] === 'text' && String(p['text']).includes('text layer')),
    ).toBe(true);
    expect(firstCall(create).messages[0]?.role).toBe('user');
  });

  it('requests structured output without unsupported numeric constraints', async () => {
    const { client, create } = fakeClient(okMessage());
    await build(client).extract(request);
    const format = firstCall(create).output_config?.format;
    expect(format?.type).toBe('json_schema');
    const serialized = JSON.stringify(format?.schema);
    expect(serialized).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum)"/);
    expect(format?.schema['additionalProperties']).toBe(false);
    expect(serialized).toContain('overallConfidence');
  });

  it('does not send sampling or thinking parameters', async () => {
    const { client, create } = fakeClient(okMessage());
    await build(client).extract(request);
    const call = firstCall(create) as unknown as Record<string, unknown>;
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) {
      expect(call).not.toHaveProperty(key);
    }
  });

  describe('fallback', () => {
    it.each([
      ['overloaded (529)', new HttpError(529)],
      ['server error (500)', new HttpError(500)],
      ['network failure', new HttpError(undefined)],
      ['model not found (404)', new HttpError(404)],
      ['timeout (408)', new HttpError(408)],
    ])('retries once on the fallback model after %s', async (_name, failure) => {
      const { client, create } = fakeClient(failure, okMessage());
      const response = await build(client).extract(request);
      expect(create).toHaveBeenCalledTimes(2);
      expect(firstCall(create, 1).model).toBe('fallback-model');
      expect(response.modelId).toBe('fallback-model');
    });

    it('falls back after a refusal', async () => {
      const { client, create } = fakeClient(
        okMessage('', { stop_reason: 'refusal', content: [] }),
        okMessage(),
      );
      const response = await build(client).extract(request);
      expect(create).toHaveBeenCalledTimes(2);
      expect(response.modelId).toBe('fallback-model');
    });

    it('falls back after non-JSON output', async () => {
      const { client } = fakeClient(okMessage('not json at all'), okMessage());
      expect((await build(client).extract(request)).modelId).toBe('fallback-model');
    });

    it('falls back after a rate limit, as the original does', async () => {
      const { client } = fakeClient(new HttpError(429), okMessage());
      expect((await build(client).extract(request)).modelId).toBe('fallback-model');
    });

    it.each([400, 401, 403])('does not fall back on a %i configuration error', async (status) => {
      const { client, create } = fakeClient(new HttpError(status), okMessage());
      await expect(build(client).extract(request)).rejects.toBeInstanceOf(
        ExtractionLlmProviderError,
      );
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('raises the typed provider error when the fallback also fails (no third call)', async () => {
      const { client, create } = fakeClient(new HttpError(500), new HttpError(503));
      const error = await build(client)
        .extract(request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExtractionLlmProviderError);
      expect((error as ExtractionLlmProviderError).retryable).toBe(true);
      expect(create).toHaveBeenCalledTimes(2);
    });

    it('does not retry when no fallback model is configured', async () => {
      const { client, create } = fakeClient(new HttpError(500), okMessage());
      await expect(build(client, null).extract(request)).rejects.toBeInstanceOf(
        ExtractionLlmProviderError,
      );
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('does not retry when the fallback equals the primary model', async () => {
      const { client, create } = fakeClient(new HttpError(500), okMessage());
      await expect(build(client, 'primary-model').extract(request)).rejects.toBeInstanceOf(
        ExtractionLlmProviderError,
      );
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  describe('typed errors', () => {
    it('maps a refusal on every model to ExtractionLlmRefusalError', async () => {
      const refusal = okMessage('', { stop_reason: 'refusal', content: [] });
      const { client } = fakeClient(refusal, refusal);
      await expect(build(client).extract(request)).rejects.toBeInstanceOf(
        ExtractionLlmRefusalError,
      );
    });

    it('maps non-JSON output to ExtractionLlmInvalidOutputError', async () => {
      const { client } = fakeClient(okMessage('nope'), okMessage('nope'));
      await expect(build(client).extract(request)).rejects.toBeInstanceOf(
        ExtractionLlmInvalidOutputError,
      );
    });

    it('maps schema-invalid output to ExtractionLlmInvalidOutputError without echoing values', async () => {
      const bad = JSON.stringify({ ...JSON.parse(validJson), secretKey123: 'TOPSECRET' });
      const { client } = fakeClient(okMessage(bad), okMessage(bad));
      const error = await build(client)
        .extract(request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExtractionLlmInvalidOutputError);
      expect((error as Error).message).not.toContain('secretKey123');
      expect((error as Error).message).not.toContain('TOPSECRET');
    });

    it('maps a response without a text block to ExtractionLlmInvalidOutputError', async () => {
      const empty = okMessage('', { content: [{ type: 'thinking', thinking: '' }] });
      const { client } = fakeClient(empty, empty);
      await expect(build(client).extract(request)).rejects.toBeInstanceOf(
        ExtractionLlmInvalidOutputError,
      );
    });

    it('maps a truncated response (max_tokens) to ExtractionLlmInvalidOutputError', async () => {
      const cut = okMessage('{"cdc":', { stop_reason: 'max_tokens' });
      const { client } = fakeClient(cut, cut);
      await expect(build(client).extract(request)).rejects.toBeInstanceOf(
        ExtractionLlmInvalidOutputError,
      );
    });

    it('reads retry-after from a Headers object on a final 429', async () => {
      const limited = new HttpError(429, new Headers({ 'retry-after': '17' }));
      const { client } = fakeClient(limited, limited);
      const error = await build(client)
        .extract(request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExtractionLlmRateLimitedError);
      expect((error as ExtractionLlmRateLimitedError).retryAfterSeconds).toBe(17);
    });

    it('reads retry-after from a plain header record', async () => {
      const limited = new HttpError(429, { 'retry-after': '3' });
      const { client } = fakeClient(limited, limited);
      const error = await build(client)
        .extract(request)
        .catch((e: unknown) => e);
      expect((error as ExtractionLlmRateLimitedError).retryAfterSeconds).toBe(3);
    });

    it.each([
      undefined,
      { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      { 'retry-after': '-4' },
    ])(
      'reports retryAfterSeconds null when the header is missing or unusable: %j',
      async (headers) => {
        const limited = new HttpError(429, headers);
        const { client } = fakeClient(limited, limited);
        const error = await build(client)
          .extract(request)
          .catch((e: unknown) => e);
        expect((error as ExtractionLlmRateLimitedError).retryAfterSeconds).toBeNull();
      },
    );

    it('never leaks provider messages into the provider error', async () => {
      const { client } = fakeClient(new HttpError(500), new HttpError(500));
      const error = await build(client)
        .extract(request)
        .catch((e: unknown) => e);
      expect((error as Error).message).not.toContain('secret document text');
      expect((error as Error).message).toContain('500');
    });

    it('classifies 4xx as non-retryable and network errors as retryable', async () => {
      const a = await build(fakeClient(new HttpError(401)).client)
        .extract(request)
        .catch((e: unknown) => e);
      expect((a as ExtractionLlmProviderError).retryable).toBe(false);
      const b = await build(fakeClient(new HttpError(undefined)).client, null)
        .extract(request)
        .catch((e: unknown) => e);
      expect((b as ExtractionLlmProviderError).retryable).toBe(true);
    });
  });
});

describe('createAnthropicExtractionLlm', () => {
  const base = {
    model: 'primary-model',
    fallbackModel: 'fallback-model',
    autoConfirmThreshold: 0.85,
    timeoutMs: 45_000,
  };

  it('returns a disabled stub without an API key and never builds a client', async () => {
    const clientFactory = vi.fn();
    const llm = createAnthropicExtractionLlm({ ...base, apiKey: null }, { clientFactory });
    await expect(llm.extract(request)).rejects.toBeInstanceOf(ExtractionLlmDisabledError);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('builds the client with the key and uses the configured models', async () => {
    const { client, create } = fakeClient(okMessage());
    const clientFactory = vi.fn(() => client);
    const llm = createAnthropicExtractionLlm({ ...base, apiKey: 'sk-test' }, { clientFactory });
    expect(clientFactory).toHaveBeenCalledWith('sk-test', expect.any(Object));
    await llm.extract(request);
    expect(firstCall(create).model).toBe('primary-model');
  });

  it('disables SDK retries and bounds the request timeout', () => {
    const { client } = fakeClient(okMessage());
    const clientFactory = vi.fn(() => client);
    createAnthropicExtractionLlm({ ...base, apiKey: 'sk-test' }, { clientFactory });
    expect(clientFactory).toHaveBeenCalledWith('sk-test', { maxRetries: 0, timeout: 45_000 });
  });

  it('never falls back when the fallback is explicitly disabled', async () => {
    // 529 is fallback-eligible, so only the explicit opt-out can explain the single call.
    const { client, create } = fakeClient(new HttpError(529), okMessage());
    const llm = createAnthropicExtractionLlm(
      { ...base, apiKey: 'sk-test', fallbackModel: null },
      { clientFactory: () => client },
    );
    await expect(llm.extract(request)).rejects.toBeInstanceOf(ExtractionLlmProviderError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('falls back to the configured model after the same eligible error', async () => {
    const { client, create } = fakeClient(new HttpError(529), okMessage());
    const llm = createAnthropicExtractionLlm(
      { ...base, apiKey: 'sk-test' },
      { clientFactory: () => client },
    );
    const response = await llm.extract(request);
    expect(create).toHaveBeenCalledTimes(2);
    expect(firstCall(create, 1).model).toBe('fallback-model');
    expect(response.modelId).toBe('fallback-model');
  });
});
