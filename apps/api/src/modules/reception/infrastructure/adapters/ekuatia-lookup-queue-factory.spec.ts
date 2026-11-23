import { describe, expect, it } from 'vitest';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';
import { createEkuatiaLookupQueue } from './ekuatia-lookup-queue-factory.js';

const job = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  cdc: '01444444017001001001452822017012515873260988',
  usageDate: '2026-11-16',
};

describe('createEkuatiaLookupQueue', () => {
  it.each([undefined, '', '  '])(
    'degrades to an unavailable queue when REDIS_URL is %j',
    async (value) => {
      const queue = createEkuatiaLookupQueue({ REDIS_URL: value });
      await expect(queue.enqueueLookup(job)).rejects.toBeInstanceOf(ReceptionQueueUnavailableError);
      await queue.close();
    },
  );

  it('rejects a REDIS_URL that is not a redis URL without echoing it', () => {
    expect(() => createEkuatiaLookupQueue({ REDIS_URL: 'http://user:secret@host' })).toThrow(
      'REDIS_URL must be a redis:// or rediss:// URL',
    );
  });

  it('turns an unreachable Redis into ReceptionQueueUnavailableError', async () => {
    const queue = createEkuatiaLookupQueue({ REDIS_URL: 'redis://127.0.0.1:1' });
    await expect(queue.enqueueLookup(job)).rejects.toBeInstanceOf(ReceptionQueueUnavailableError);
    await queue.close();
  }, 10_000);
});
