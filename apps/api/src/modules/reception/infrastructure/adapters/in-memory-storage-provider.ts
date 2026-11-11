import {
  STORAGE_PRESIGN_DEFAULT_SECONDS,
  StorageObjectNotFoundError,
  type StoragePresignOptions,
  type StorageProvider,
} from '../../application/ports/storage-provider.port.js';

export interface InMemoryStorageProviderOptions {
  /** Makes `ping` reject, to exercise readiness failures. */
  readonly pingFails?: boolean;
}

/** Map-backed fake for tests. Bytes are copied on the way in and out. */
export class InMemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, Uint8Array>();

  constructor(private readonly options: InMemoryStorageProviderOptions = {}) {}

  upload(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body.slice());
    return Promise.resolve();
  }

  download(key: string): Promise<Uint8Array> {
    const body = this.objects.get(key);
    return body === undefined
      ? Promise.reject(new StorageObjectNotFoundError(key))
      : Promise.resolve(body.slice());
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  presignedUrl(key: string, opts?: StoragePresignOptions): Promise<string> {
    const seconds = opts?.expiresInSeconds ?? STORAGE_PRESIGN_DEFAULT_SECONDS;
    return Promise.resolve(`memory://${key}?expires=${String(seconds)}`);
  }

  ping(): Promise<void> {
    return this.options.pingFails === true
      ? Promise.reject(new Error('storage unavailable'))
      : Promise.resolve();
  }
}
