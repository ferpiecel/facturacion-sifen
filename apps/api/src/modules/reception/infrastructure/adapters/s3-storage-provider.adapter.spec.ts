import { describe, expect, it, vi } from 'vitest';
import { StorageObjectNotFoundError } from '../../application/ports/storage-provider.port.js';
import {
  S3StorageProvider,
  createS3Client,
  type S3ClientLike,
  type S3Presigner,
} from './s3-storage-provider.adapter.js';
import { describeStorageProviderContract } from './storage-provider.contract.js';

interface Sent {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

class WireError extends Error {
  constructor(
    name: string,
    readonly status?: number,
  ) {
    super(name);
    this.name = name;
  }
  get $metadata(): { httpStatusCode?: number } {
    return { httpStatusCode: this.status };
  }
}

/** Map-backed fake of the subset of the S3 wire behaviour the adapter relies on. */
function fakeS3(opts: { failBucket?: boolean } = {}): S3ClientLike & { sent: Sent[] } {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  const sent: Sent[] = [];
  return {
    sent,
    send(command) {
      const name = command.constructor.name;
      const input = command.input as Record<string, unknown>;
      sent.push({ name, input });
      const key = input.Key as string;
      switch (name) {
        case 'PutObjectCommand':
          objects.set(key, {
            body: input.Body as Uint8Array,
            contentType: input.ContentType as string | undefined,
          });
          return Promise.resolve({});
        case 'GetObjectCommand': {
          const found = objects.get(key);
          if (!found) return Promise.reject(new WireError('NoSuchKey', 404));
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from(found.body)) },
          });
        }
        case 'HeadObjectCommand':
          return objects.has(key)
            ? Promise.resolve({})
            : Promise.reject(new WireError('NotFound', 404));
        case 'DeleteObjectCommand':
          objects.delete(key);
          return Promise.resolve({});
        case 'HeadBucketCommand':
          return opts.failBucket
            ? Promise.reject(new WireError('Forbidden', 403))
            : Promise.resolve({});
        default:
          return Promise.reject(new Error(`unexpected command ${name}`));
      }
    },
  };
}

const presigner: S3Presigner = (_client, command, o) => {
  const input = command.input as { Key: string };
  return Promise.resolve(
    `https://s3.test/bucket/${input.Key}?X-Amz-Expires=${String(o.expiresIn)}`,
  );
};

const make = (client: S3ClientLike = fakeS3()): S3StorageProvider =>
  new S3StorageProvider({ client, bucket: 'bucket', presigner });

describeStorageProviderContract('S3StorageProvider (mocked client)', () => make());

describe('S3StorageProvider specifics', () => {
  it('forwards bucket, key, body and content type on upload', async () => {
    const client = fakeS3();
    await make(client).upload('a/b.pdf', Uint8Array.from([1]), { contentType: 'application/pdf' });
    expect(client.sent[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: { Bucket: 'bucket', Key: 'a/b.pdf', ContentType: 'application/pdf' },
    });
  });

  it('maps a 404 without a known name to StorageObjectNotFoundError on download', async () => {
    const client: S3ClientLike = {
      send: () => Promise.reject(new WireError('Whatever', 404)),
    };
    await expect(make(client).download('k')).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it('rethrows non-404 errors on download', async () => {
    const client: S3ClientLike = {
      send: () => Promise.reject(new WireError('AccessDenied', 403)),
    };
    await expect(make(client).download('k')).rejects.toThrow('AccessDenied');
  });

  it('rethrows non-404 errors on exists', async () => {
    const client: S3ClientLike = {
      send: () => Promise.reject(new WireError('AccessDenied', 403)),
    };
    await expect(make(client).exists('k')).rejects.toThrow('AccessDenied');
  });

  it('rejects ping when the bucket is not reachable', async () => {
    await expect(make(fakeS3({ failBucket: true })).ping()).rejects.toThrow('Forbidden');
  });

  it('presigns a GetObject with the default and explicit expiry', async () => {
    const storage = make();
    expect(await storage.presignedUrl('k')).toContain('X-Amz-Expires=900');
    expect(await storage.presignedUrl('k', { expiresInSeconds: 60 })).toContain('X-Amz-Expires=60');
  });

  it('passes the bucket to the presigned GetObject', async () => {
    const spy = vi.fn(presigner);
    const storage = new S3StorageProvider({ client: fakeS3(), bucket: 'bucket', presigner: spy });
    await storage.presignedUrl('k');
    expect(spy.mock.calls[0]?.[1].input).toEqual({ Bucket: 'bucket', Key: 'k' });
  });
});

describe('createS3Client', () => {
  it('uses path-style addressing, the custom endpoint and the configured region', async () => {
    const client = createS3Client({
      endpointUrl: 'http://localhost:8333',
      bucket: 'b',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      region: 'sa-east-1',
    });
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe('sa-east-1');
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe('localhost');
    expect(endpoint?.port).toBe(8333);
    client.destroy();
  });
});
