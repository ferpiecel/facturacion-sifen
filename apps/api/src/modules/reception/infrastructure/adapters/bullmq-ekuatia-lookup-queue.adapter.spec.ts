import { describe, expect, it, vi } from 'vitest';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';
import {
  BullmqEkuatiaLookupQueue,
  RECEPTION_EKUATIA_LOOKUP_ATTEMPTS,
  RECEPTION_EKUATIA_LOOKUP_QUEUE,
} from './bullmq-ekuatia-lookup-queue.adapter.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CDC = '01444444017001001001452822017012515873260988';
const job = { tenantId: TENANT, cdc: CDC, usageDate: '2026-11-16' };

const fakeQueue = (
  add = vi.fn().mockResolvedValue({}),
  getJob = vi.fn().mockResolvedValue(undefined),
) => ({ add, getJob });

describe('BullmqEkuatiaLookupQueue', () => {
  it('names the queue without a colon (BullMQ rejects it)', () => {
    expect(RECEPTION_EKUATIA_LOOKUP_QUEUE).toBe('reception-ekuatia-lookup');
  });

  it('adds one job per (tenant, CDC) with a deterministic id and the job data', async () => {
    const queue = fakeQueue();
    await new BullmqEkuatiaLookupQueue({ queue }).enqueueLookup(job);
    const [name, data, opts] = queue.add.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(name).toBe('lookup');
    expect(data).toEqual(job);
    expect(opts.jobId).toBe(`reception-ekuatia-lookup:${TENANT}:${CDC}`);
  });

  it('never retries a job on its own: each retry would spend another paid solve', async () => {
    const queue = fakeQueue();
    await new BullmqEkuatiaLookupQueue({ queue }).enqueueLookup(job);
    expect(RECEPTION_EKUATIA_LOOKUP_ATTEMPTS).toBe(1);
    const opts = (queue.add.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(opts.attempts).toBe(1);
  });

  it('drops finished jobs so a failed lookup can be requested again', async () => {
    const queue = fakeQueue();
    await new BullmqEkuatiaLookupQueue({ queue }).enqueueLookup(job);
    const opts = (queue.add.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(true);
  });

  it('reports enqueued=false when a job with that id already exists', async () => {
    const queue = fakeQueue(vi.fn().mockResolvedValue({}), vi.fn().mockResolvedValue({ id: 'x' }));
    expect(await new BullmqEkuatiaLookupQueue({ queue }).enqueueLookup(job)).toEqual({
      enqueued: false,
    });
  });

  it('reports enqueued=true for a new job', async () => {
    expect(await new BullmqEkuatiaLookupQueue({ queue: fakeQueue() }).enqueueLookup(job)).toEqual({
      enqueued: true,
    });
  });

  it('turns a Redis failure into ReceptionQueueUnavailableError carrying only the error class', async () => {
    const queue = fakeQueue(vi.fn().mockRejectedValue(new Error('connect redis://secret@host')));
    const error = await new BullmqEkuatiaLookupQueue({ queue })
      .enqueueLookup(job)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceptionQueueUnavailableError);
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain(CDC);
  });

  it('times out instead of hanging the request when Redis does not answer', async () => {
    const queue = fakeQueue(vi.fn().mockReturnValue(new Promise(() => undefined)));
    await expect(
      new BullmqEkuatiaLookupQueue({ queue, timeoutMs: 20 }).enqueueLookup(job),
    ).rejects.toBeInstanceOf(ReceptionQueueUnavailableError);
  });
});
