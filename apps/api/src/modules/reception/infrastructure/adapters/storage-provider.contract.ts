import { describe, expect, it } from 'vitest';
import {
  STORAGE_PRESIGN_DEFAULT_SECONDS,
  StorageObjectNotFoundError,
  type StorageProvider,
} from '../../application/ports/storage-provider.port.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

/**
 * Shared behavioural suite for every `StorageProvider` adapter. It asserts only what holds for
 * ANY adapter; adapter-specific details (URL format, wire errors) belong in the adapter's spec.
 * Each test gets a fresh provider from `factory`.
 */
export function describeStorageProviderContract(
  name: string,
  factory: () => StorageProvider | Promise<StorageProvider>,
): void {
  describe(`StorageProvider contract: ${name}`, () => {
    it('round-trips uploaded bytes', async () => {
      const storage = await factory();
      await storage.upload('a/b/doc.pdf', bytes(1, 2, 3), { contentType: 'application/pdf' });
      expect(Array.from(await storage.download('a/b/doc.pdf'))).toEqual([1, 2, 3]);
    });

    it('uploads without options', async () => {
      const storage = await factory();
      await storage.upload('plain', bytes(9));
      expect(Array.from(await storage.download('plain'))).toEqual([9]);
    });

    it('round-trips an empty body', async () => {
      const storage = await factory();
      await storage.upload('empty', new Uint8Array());
      expect((await storage.download('empty')).byteLength).toBe(0);
      expect(await storage.exists('empty')).toBe(true);
    });

    it('overwrites an existing key', async () => {
      const storage = await factory();
      await storage.upload('k', bytes(1));
      await storage.upload('k', bytes(2, 2));
      expect(Array.from(await storage.download('k'))).toEqual([2, 2]);
    });

    it('throws StorageObjectNotFoundError when downloading a missing key', async () => {
      const storage = await factory();
      await expect(storage.download('missing')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('deletes an object and tolerates deleting it again', async () => {
      const storage = await factory();
      await storage.upload('k', bytes(1));
      await storage.delete('k');
      expect(await storage.exists('k')).toBe(false);
      await expect(storage.delete('k')).resolves.toBeUndefined();
      await expect(storage.delete('never-existed')).resolves.toBeUndefined();
    });

    it('reports existence', async () => {
      const storage = await factory();
      expect(await storage.exists('k')).toBe(false);
      await storage.upload('k', bytes(1));
      expect(await storage.exists('k')).toBe(true);
    });

    it('presigns a non-empty URL that references the key', async () => {
      const storage = await factory();
      await storage.upload('tenant/file.xml', bytes(1));
      const url = await storage.presignedUrl('tenant/file.xml');
      expect(url.length).toBeGreaterThan(0);
      expect(url).toContain('tenant/file.xml');
    });

    it('accepts an explicit expiry and exposes the default constant', async () => {
      const storage = await factory();
      expect(STORAGE_PRESIGN_DEFAULT_SECONDS).toBe(900);
      await expect(storage.presignedUrl('k')).resolves.toEqual(expect.any(String));
      await expect(storage.presignedUrl('k', { expiresInSeconds: 60 })).resolves.toEqual(
        expect.any(String),
      );
    });

    it('resolves ping when healthy', async () => {
      const storage = await factory();
      await expect(storage.ping()).resolves.toBeUndefined();
    });
  });
}
