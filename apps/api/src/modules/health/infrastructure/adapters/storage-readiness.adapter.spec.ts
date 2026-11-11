import { describe, expect, it } from 'vitest';
import { StorageReadinessAdapter } from './storage-readiness.adapter.js';

describe('StorageReadinessAdapter', () => {
  it('is skipped when storage is not configured', async () => {
    await expect(new StorageReadinessAdapter(null).check()).resolves.toBe('skipped');
  });

  it('is up when ping resolves', async () => {
    const adapter = new StorageReadinessAdapter({ ping: () => Promise.resolve() });
    await expect(adapter.check()).resolves.toBe('up');
  });

  it('is down when ping rejects, without surfacing the error', async () => {
    const adapter = new StorageReadinessAdapter({
      ping: () => Promise.reject(new Error('https://secret-host/bucket denied')),
    });
    await expect(adapter.check()).resolves.toBe('down');
  });

  it('is down when ping exceeds the timeout', async () => {
    const adapter = new StorageReadinessAdapter({ ping: () => new Promise<void>(() => {}) }, 20);
    await expect(adapter.check()).resolves.toBe('down');
  });
});
