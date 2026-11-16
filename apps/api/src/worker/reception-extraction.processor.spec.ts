import { InvalidTenantIdError } from '@sifen/db';
import { describe, expect, it, vi } from 'vitest';
import type {
  ExtractReceivedDocumentInput,
  ExtractReceivedDocumentResult,
} from '../modules/reception/application/extract-received-document.js';
import {
  RECEPTION_EXTRACTION_QUEUE,
  ReceptionExtractionRetryableError,
  createReceptionExtractionProcessor,
} from './reception-extraction.processor.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';

const document = { id: DOC } as never;

const job = (
  over: {
    attemptsMade?: number;
    attempts?: number;
    stalledCounter?: number;
    tenantId?: string;
  } = {},
) => ({
  data: { tenantId: over.tenantId ?? TENANT, documentId: DOC },
  attemptsMade: over.attemptsMade ?? 0,
  stalledCounter: over.stalledCounter ?? 0,
  opts: { attempts: over.attempts ?? 3 },
});

function setup(result: ExtractReceivedDocumentResult | Error) {
  const execute = vi.fn<
    (input: ExtractReceivedDocumentInput) => Promise<ExtractReceivedDocumentResult>
  >(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
  const failUnexpected = vi.fn<(input: { tenantId: string; documentId: string }) => Promise<void>>(
    () => Promise.resolve(),
  );
  const logger = { info: vi.fn(), warn: vi.fn() };
  const process = createReceptionExtractionProcessor({
    extract: { execute, failUnexpected },
    logger,
  });
  return { execute, failUnexpected, logger, process };
}

const failed = (retryable: boolean, retryAfterSeconds: number | null = null) =>
  ({
    kind: 'failed',
    code: retryable ? 'llm_provider_error' : 'corrupt_pdf',
    retryable,
    retryAfterSeconds,
    document,
  }) as ExtractReceivedDocumentResult;

describe('reception extraction processor', () => {
  it('shares the queue name with the producer', () => {
    expect(RECEPTION_EXTRACTION_QUEUE).toBe('reception-extraction');
  });

  it('validates the tenant id before running anything', async () => {
    const { execute, process } = setup({ kind: 'skipped', reason: 'not_found' });
    await expect(process(job({ tenantId: "x'; drop table" }))).rejects.toBeInstanceOf(
      InvalidTenantIdError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes the tenant, document, attempt and finality to the use case', async () => {
    const { execute, process } = setup({ kind: 'skipped', reason: 'already_processed' });
    await process(job({ attemptsMade: 1, attempts: 3 }));
    expect(execute).toHaveBeenCalledWith({
      tenantId: TENANT,
      documentId: DOC,
      attempt: 2,
      finalAttempt: false,
    });
    await process(job({ attemptsMade: 2, attempts: 3 }));
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 3, finalAttempt: true }),
    );
  });

  it('completes an extracted document and a skipped job', async () => {
    const extracted = setup({ kind: 'extracted', status: 'confirmed', document, events: [] });
    await expect(extracted.process(job())).resolves.toEqual({ outcome: 'extracted:confirmed' });
    const skipped = setup({ kind: 'skipped', reason: 'in_progress' });
    await expect(skipped.process(job())).resolves.toEqual({ outcome: 'skipped:in_progress' });
  });

  it('completes a non-retryable failure: the document is already extraction_failed', async () => {
    const { process, logger } = setup(failed(false));
    await expect(process(job())).resolves.toEqual({ outcome: 'failed:corrupt_pdf' });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('throws a retryable failure so BullMQ retries with backoff', async () => {
    const { process } = setup(failed(true, 30));
    const error = await process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceptionExtractionRetryableError);
    expect((error as Error).message).toBe('llm_provider_error');
  });

  it('counts a stalled rerun as a later attempt so the use case resumes it', async () => {
    const { execute, process } = setup({ kind: 'skipped', reason: 'already_processed' });
    await process(job({ attemptsMade: 0, stalledCounter: 1, attempts: 3 }));
    // attempt > 1 resumes an `extracting` document; finality still reads real attempts only.
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2, finalAttempt: false }),
    );
    await process(job({ attemptsMade: 2, stalledCounter: 1, attempts: 3 }));
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 4, finalAttempt: true }),
    );
  });

  it('lets an unexpected error propagate on a non-final attempt without failing the document', async () => {
    const { process, failUnexpected } = setup(new Error('boom'));
    await expect(process(job({ attemptsMade: 0 }))).rejects.toThrow('boom');
    expect(failUnexpected).not.toHaveBeenCalled();
  });

  it('fails the document when an unexpected error hits the final attempt, then rethrows', async () => {
    const { process, failUnexpected } = setup(new Error('boom'));
    await expect(process(job({ attemptsMade: 2 }))).rejects.toThrow('boom');
    expect(failUnexpected).toHaveBeenCalledWith({ tenantId: TENANT, documentId: DOC });
  });

  it('still rethrows the original error when marking the document failed also fails', async () => {
    const { process, failUnexpected, logger } = setup(new Error('boom'));
    failUnexpected.mockRejectedValueOnce(new Error('db down'));
    await expect(process(job({ attemptsMade: 2 }))).rejects.toThrow('boom');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logs ids, codes and counts only', async () => {
    const { process, logger } = setup(failed(true, 12));
    await process(job()).catch(() => undefined);
    const lines = [...logger.info.mock.calls, ...logger.warn.mock.calls].map(String).join('\n');
    expect(lines).toContain(DOC);
    expect(lines).toContain('llm_provider_error');
    expect(lines).not.toMatch(/sk-|prompt|<xml/i);
  });
});
