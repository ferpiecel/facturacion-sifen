import { describe, expect, it, vi } from 'vitest';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';
import {
  BullmqReceptionJobQueue,
  RECEPTION_EXTRACTION_QUEUE,
  type ReceptionExtractionJobData,
} from './bullmq-reception-job-queue.adapter.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';

const fakeQueue = (add = vi.fn().mockResolvedValue({})) => ({ add });

describe('BullmqReceptionJobQueue', () => {
  it('names the queue without a colon (BullMQ rejects it)', () => {
    expect(RECEPTION_EXTRACTION_QUEUE).toBe('reception-extraction');
  });

  it('adds one job per (document, attempt) with a deterministic job id', async () => {
    const queue = fakeQueue();
    await new BullmqReceptionJobQueue({ queue }).enqueueExtraction({
      tenantId: TENANT,
      documentId: DOC,
    });
    const [name, data, opts] = queue.add.mock.calls[0] as [
      string,
      ReceptionExtractionJobData,
      Record<string, unknown>,
    ];
    expect(name).toBe('extract');
    expect(data).toEqual({ tenantId: TENANT, documentId: DOC });
    expect(opts.jobId).toBe(`reception-extraction:${DOC}:1`);
  });

  it('puts an explicit attempt in the job id', async () => {
    const queue = fakeQueue();
    await new BullmqReceptionJobQueue({ queue }).enqueueExtraction({
      tenantId: TENANT,
      documentId: DOC,
      attempt: 3,
    });
    expect((queue.add.mock.calls[0] as unknown[])[2]).toMatchObject({
      jobId: `reception-extraction:${DOC}:3`,
    });
  });

  it('retries with exponential backoff and bounds the retained history', async () => {
    const queue = fakeQueue();
    await new BullmqReceptionJobQueue({ queue }).enqueueExtraction({
      tenantId: TENANT,
      documentId: DOC,
    });
    expect((queue.add.mock.calls[0] as unknown[])[2]).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: 500,
    });
  });

  it('maps a connection failure to ReceptionQueueUnavailableError without leaking its message', async () => {
    const queue = fakeQueue(vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED redis://h')));
    const failure = await new BullmqReceptionJobQueue({ queue })
      .enqueueExtraction({ tenantId: TENANT, documentId: DOC })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ReceptionQueueUnavailableError);
    expect((failure as Error).message).not.toContain('redis://');
  });

  it('gives up when Redis does not answer in time', async () => {
    const queue = fakeQueue(vi.fn().mockReturnValue(new Promise(() => undefined)));
    await expect(
      new BullmqReceptionJobQueue({ queue, timeoutMs: 20 }).enqueueExtraction({
        tenantId: TENANT,
        documentId: DOC,
      }),
    ).rejects.toBeInstanceOf(ReceptionQueueUnavailableError);
  });
});
