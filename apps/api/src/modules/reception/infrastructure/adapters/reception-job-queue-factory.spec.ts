import { describe, expect, it } from 'vitest';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';
import { createReceptionJobQueue } from './reception-job-queue-factory.js';

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
});
