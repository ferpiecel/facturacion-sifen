import { describe, expect, it, vi } from 'vitest';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';
import { createReceptionJobQueue, createThrottledErrorLog } from './reception-job-queue-factory.js';

const job = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222',
};

describe('createReceptionJobQueue', () => {
  it.each([undefined, '', '  '])(
    'degrades to an unavailable queue when REDIS_URL is %j',
    async (value) => {
      const queue = createReceptionJobQueue({ REDIS_URL: value });
      await expect(queue.enqueueExtraction(job)).rejects.toBeInstanceOf(
        ReceptionQueueUnavailableError,
      );
      await queue.close();
    },
  );

  it('rejects a REDIS_URL that is not a redis URL without echoing it', () => {
    expect(() => createReceptionJobQueue({ REDIS_URL: 'http://user:secret@host' })).toThrow(
      'REDIS_URL must be a redis:// or rediss:// URL',
    );
    expect(() => createReceptionJobQueue({ REDIS_URL: 'http://user:secret@host' })).not.toThrow(
      /secret/,
    );
  });

  it('does not connect until the first job (an unreachable Redis never blocks the boot)', async () => {
    const queue = createReceptionJobQueue({ REDIS_URL: 'redis://127.0.0.1:1' });
    await queue.close(); // nothing was opened, nothing to close
    expect(queue).toBeDefined();
  });

  it('turns an unreachable Redis into ReceptionQueueUnavailableError', async () => {
    const queue = createReceptionJobQueue({ REDIS_URL: 'redis://127.0.0.1:1' });
    await expect(queue.enqueueExtraction(job)).rejects.toBeInstanceOf(
      ReceptionQueueUnavailableError,
    );
    await queue.close();
  }, 10_000);
});

describe('createThrottledErrorLog', () => {
  it('logs the first error, then at most once per interval, counting what it dropped', () => {
    const write = vi.fn<(line: string) => void>();
    let now = 0;
    const log = createThrottledErrorLog(write, 60_000, () => now);

    log(new Error('a'));
    log(new Error('b'));
    now = 59_999;
    log(new Error('c'));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('reception queue connection error: Error');

    now = 60_000;
    log(new TypeError('d'));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toBe(
      'reception queue connection error: TypeError (2 more suppressed)',
    );
  });

  it('never logs the message, which may carry hosts or credentials', () => {
    const write = vi.fn<(line: string) => void>();
    createThrottledErrorLog(write, 1000, () => 0)(new Error('redis://user:secret@host'));
    expect(write.mock.calls[0]?.[0]).not.toContain('secret');
  });
});
