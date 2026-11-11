import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtractReceivedDocumentResult } from '../modules/reception/application/extract-received-document.js';
import {
  BullmqReceptionJobQueue,
  RECEPTION_EXTRACTION_QUEUE,
} from '../modules/reception/infrastructure/adapters/bullmq-reception-job-queue.adapter.js';
import { createReceptionExtractionWorker, createRedisConnection } from './queue.js';
import { createReceptionExtractionProcessor } from './reception-extraction.processor.js';

const REDIS_URL = process.env.REDIS_URL;
const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const document = { id: DOC } as never;

const until = async (condition: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Spec: reception R5.6. Runs against a real Redis only when `REDIS_URL` is set (CI's `worker-redis`
 * job; locally `REDIS_URL=redis://localhost:6379 pnpm --filter @sifen/api exec vitest run
 * src/worker/reception-extraction.integration.spec.ts`). Skipped otherwise.
 */
describe.skipIf(!REDIS_URL)('reception extraction queue (real Redis)', () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  const open = (backoffMs = 30_000) => {
    const prefix = `test-${randomUUID()}`;
    const connection = createRedisConnection(REDIS_URL ?? '');
    cleanup.push(() => connection.quit());
    const queue = new Queue(RECEPTION_EXTRACTION_QUEUE, { connection, prefix });
    cleanup.push(() => queue.close());
    return { prefix, connection, producer: new BullmqReceptionJobQueue({ queue, backoffMs }) };
  };

  const startWorker = (
    ctx: ReturnType<typeof open>,
    execute: () => Promise<ExtractReceivedDocumentResult>,
  ) => {
    const worker = createReceptionExtractionWorker({
      connection: ctx.connection,
      concurrency: 1,
      prefix: ctx.prefix,
      process: createReceptionExtractionProcessor({
        extract: { execute, failUnexpected: () => Promise.resolve() },
      }),
    });
    cleanup.push(() => worker.close());
    return worker;
  };

  it('runs a job once however many times it is enqueued', async () => {
    const ctx = open();
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: 'extracted',
        status: 'confirmed',
        document,
        events: [],
      } as ExtractReceivedDocumentResult),
    );
    startWorker(ctx, execute);

    await ctx.producer.enqueueExtraction({ tenantId: TENANT, documentId: DOC });
    await ctx.producer.enqueueExtraction({ tenantId: TENANT, documentId: DOC });
    await until(() => execute.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      tenantId: TENANT,
      documentId: DOC,
      attempt: 1,
      finalAttempt: false,
    });
  });

  it('retries a retryable failure with backoff and flags the last attempt', async () => {
    const ctx = open(50);
    const failure = {
      kind: 'failed',
      code: 'llm_provider_error',
      retryable: true,
      retryAfterSeconds: null,
      document,
    } as ExtractReceivedDocumentResult;
    const inputs: { attempt?: number; finalAttempt?: boolean }[] = [];
    const execute = vi.fn((): Promise<ExtractReceivedDocumentResult> => {
      return Promise.resolve(
        inputs.length < 3
          ? failure
          : ({ kind: 'extracted', status: 'confirmed', document, events: [] } as never),
      );
    });
    const worker = createReceptionExtractionWorker({
      connection: ctx.connection,
      concurrency: 1,
      prefix: ctx.prefix,
      process: createReceptionExtractionProcessor({
        extract: {
          execute: (input) => {
            inputs.push(input);
            return execute();
          },
          failUnexpected: () => Promise.resolve(),
        },
      }),
    });
    cleanup.push(() => worker.close());

    await ctx.producer.enqueueExtraction({ tenantId: TENANT, documentId: DOC });
    await until(() => inputs.length >= 3);

    expect(inputs.map((i) => i.attempt)).toEqual([1, 2, 3]);
    expect(inputs.map((i) => i.finalAttempt)).toEqual([false, false, true]);
  });

  it('does not retry a non-retryable failure', async () => {
    const ctx = open(50);
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: 'failed',
        code: 'corrupt_pdf',
        retryable: false,
        retryAfterSeconds: null,
        document,
      } as ExtractReceivedDocumentResult),
    );
    startWorker(ctx, execute);

    await ctx.producer.enqueueExtraction({ tenantId: TENANT, documentId: DOC });
    await until(() => execute.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
