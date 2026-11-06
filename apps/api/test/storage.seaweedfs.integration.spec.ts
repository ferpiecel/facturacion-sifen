import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { StorageProvider } from '../src/modules/reception/application/ports/storage-provider.port.js';
import { createS3StorageProvider } from '../src/modules/reception/infrastructure/adapters/s3-storage-provider.adapter.js';
import { describeStorageProviderContract } from '../src/modules/reception/infrastructure/adapters/storage-provider.contract.js';
import {
  loadStorageConfig,
  type StorageConfig,
} from '../src/modules/reception/infrastructure/storage-config.js';

// Runs against a real SeaweedFS (docker compose service `seaweedfs`, or the CI job
// `storage-seaweedfs`). Skipped unless STORAGE_ENDPOINT_URL is set.
const enabled = (process.env.STORAGE_ENDPOINT_URL ?? '').trim() !== '';

function configFromEnv(): StorageConfig {
  const result = loadStorageConfig(process.env, 'test');
  if (result.status !== 'enabled') throw new Error('STORAGE_* environment is incomplete.');
  return result.config;
}

describe.skipIf(!enabled)('SeaweedFS storage integration', () => {
  const runPrefix = `it-${randomUUID()}`;
  const usedKeys = new Set<string>();
  const config = enabled ? configFromEnv() : undefined;
  const real = config === undefined ? undefined : createS3StorageProvider(config);

  /** Scopes every key to this run and records it for cleanup. */
  function scoped(): StorageProvider {
    const inner = real as StorageProvider;
    const full = (key: string): string => {
      const scopedKey = `${runPrefix}/${key}`;
      usedKeys.add(scopedKey);
      return scopedKey;
    };
    return {
      upload: (key, body, opts) => inner.upload(full(key), body, opts),
      download: (key) => inner.download(full(key)),
      delete: (key) => inner.delete(full(key)),
      exists: (key) => inner.exists(full(key)),
      presignedUrl: (key, opts) => inner.presignedUrl(full(key), opts),
      ping: () => inner.ping(),
    };
  }

  afterAll(async () => {
    if (real === undefined) return;
    await Promise.all([...usedKeys].map((key) => real.delete(key)));
  });

  describeStorageProviderContract('SeaweedFS (real S3)', scoped);

  describe('presigned URLs and access control', () => {
    // Resolved lazily: describe bodies also run when the suite is skipped.
    const objectUrl = (key: string): string => {
      const { endpointUrl, bucket } = config as StorageConfig;
      return `${endpointUrl.replace(/\/$/, '')}/${bucket}/${key}`;
    };

    it('serves the uploaded bytes to a plain HTTP GET of the presigned URL', async () => {
      const storage = scoped();
      const payload = Uint8Array.from([7, 8, 9, 10]);
      await storage.upload('presigned/ok.bin', payload);
      const url = await storage.presignedUrl('presigned/ok.bin');

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([7, 8, 9, 10]);
    });

    it('denies unauthenticated GET and PUT on the bucket', async () => {
      const storage = scoped();
      await storage.upload('anon/target.bin', Uint8Array.from([1]));
      const url = objectUrl(`${runPrefix}/anon/target.bin`);

      const get = await fetch(url);
      const put = await fetch(objectUrl(`${runPrefix}/anon/intruder.bin`), {
        method: 'PUT',
        body: 'x',
      });

      expect([401, 403]).toContain(get.status);
      expect([401, 403]).toContain(put.status);
    });

    it('denies a presigned URL reused for a different key', async () => {
      const storage = scoped();
      await storage.upload('swap/a.bin', Uint8Array.from([1]));
      await storage.upload('swap/b.bin', Uint8Array.from([2]));
      const url = new URL(await storage.presignedUrl('swap/a.bin'));
      url.pathname = url.pathname.replace('swap/a.bin', 'swap/b.bin');

      const response = await fetch(url);

      expect([401, 403]).toContain(response.status);
    });

    it('denies a presigned URL with a tampered signature', async () => {
      const storage = scoped();
      await storage.upload('tamper/a.bin', Uint8Array.from([1]));
      const url = new URL(await storage.presignedUrl('tamper/a.bin'));
      const signature = url.searchParams.get('X-Amz-Signature') ?? '';
      expect(signature).not.toBe('');
      const flipped = (signature.startsWith('0') ? '1' : '0') + signature.slice(1);
      url.searchParams.set('X-Amz-Signature', flipped);

      const response = await fetch(url);

      expect([401, 403]).toContain(response.status);
    });
  });
});
