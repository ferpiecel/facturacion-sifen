/** Default lifetime of a presigned download URL, in seconds. */
export const STORAGE_PRESIGN_DEFAULT_SECONDS = 900;

/** Thrown by `download` when no object exists for the key. */
export class StorageObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`storage object not found: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

export interface StorageUploadOptions {
  readonly contentType?: string;
}

export interface StoragePresignOptions {
  /** Defaults to {@link STORAGE_PRESIGN_DEFAULT_SECONDS}. */
  readonly expiresInSeconds?: number;
}

/**
 * Object storage for artifacts (uploaded files, later KuDE). Objects are addressed by an opaque
 * key; the caller owns the key scheme. Implementations must be safe to share across requests.
 */
export interface StorageProvider {
  /** Stores `body` under `key`, overwriting any existing object. */
  upload(key: string, body: Uint8Array, opts?: StorageUploadOptions): Promise<void>;
  /** Throws {@link StorageObjectNotFoundError} when the key does not exist. */
  download(key: string): Promise<Uint8Array>;
  /** Idempotent: resolves when the key does not exist. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Time-limited download URL. Does not check that the object exists. */
  presignedUrl(key: string, opts?: StoragePresignOptions): Promise<string>;
  /** Resolves when the backend is reachable; rejects otherwise. */
  ping(): Promise<void>;
}
