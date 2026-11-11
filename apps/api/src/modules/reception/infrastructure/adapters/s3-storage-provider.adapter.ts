import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  STORAGE_PRESIGN_DEFAULT_SECONDS,
  StorageObjectNotFoundError,
  type StoragePresignOptions,
  type StorageProvider,
  type StorageUploadOptions,
} from '../../application/ports/storage-provider.port.js';
import type { StorageConfig } from '../storage-config.js';

/** Structural subset of `S3Client` the adapter uses, so tests can mock it without network. */
export interface S3ClientLike {
  send(command: { readonly input: object }): Promise<{
    Body?: { transformToByteArray(): Promise<Uint8Array> };
  }>;
}

export type S3Presigner = (
  client: S3ClientLike,
  command: { readonly input: object },
  options: { expiresIn: number },
) => Promise<string>;

export interface S3StorageProviderOptions {
  readonly client: S3ClientLike;
  readonly bucket: string;
  readonly presigner: S3Presigner;
}

function httpStatus(error: unknown): number | undefined {
  const metadata = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound' || httpStatus(error) === 404;
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3ClientLike;
  private readonly bucket: string;
  private readonly presigner: S3Presigner;

  constructor(options: S3StorageProviderOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.presigner = options.presigner;
  }

  async upload(key: string, body: Uint8Array, opts?: StorageUploadOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(opts?.contentType === undefined ? {} : { ContentType: opts.contentType }),
      }),
    );
  }

  async download(key: string): Promise<Uint8Array> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (output.Body === undefined) {
        throw new StorageObjectNotFoundError(key);
      }
      return await output.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) throw error;
      if (isNotFound(error)) throw new StorageObjectNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject succeeds for missing keys, which gives idempotency for free.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  presignedUrl(key: string, opts?: StoragePresignOptions): Promise<string> {
    return this.presigner(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: opts?.expiresInSeconds ?? STORAGE_PRESIGN_DEFAULT_SECONDS,
    });
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

/** Path-style addressing is required by SeaweedFS/MinIO-style endpoints without bucket DNS. */
export function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpointUrl,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/** Builds the production provider; the SDK-to-structural casts live here only. */
export function createS3StorageProvider(config: StorageConfig): S3StorageProvider {
  const client = createS3Client(config);
  return new S3StorageProvider({
    client,
    bucket: config.bucket,
    presigner: (c, command, options) =>
      getSignedUrl(c as unknown as S3Client, command as GetObjectCommand, options),
  });
}
