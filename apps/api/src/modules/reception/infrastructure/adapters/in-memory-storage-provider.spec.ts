import { describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';
import { describeStorageProviderContract } from './storage-provider.contract.js';

describeStorageProviderContract('InMemoryStorageProvider', () => new InMemoryStorageProvider());

describe('InMemoryStorageProvider specifics', () => {
  it('fails ping when configured to', async () => {
    const storage = new InMemoryStorageProvider({ pingFails: true });
    await expect(storage.ping()).rejects.toThrow('storage unavailable');
  });

  it('presigns a deterministic fake URL with the default expiry', async () => {
    const storage = new InMemoryStorageProvider();
    expect(await storage.presignedUrl('a/b.pdf')).toBe('memory://a/b.pdf?expires=900');
    expect(await storage.presignedUrl('a/b.pdf', { expiresInSeconds: 60 })).toBe(
      'memory://a/b.pdf?expires=60',
    );
  });

  it('isolates stored bytes from caller mutation', async () => {
    const storage = new InMemoryStorageProvider();
    const body = Uint8Array.from([1, 2]);
    await storage.upload('k', body);
    body[0] = 99;
    const first = await storage.download('k');
    first[1] = 99;
    expect(Array.from(await storage.download('k'))).toEqual([1, 2]);
  });
});
