import type {
  StorageReadiness,
  StorageReadinessPort,
} from '../../application/ports/storage-readiness.port.js';

/** Structural subset of the reception `StorageProvider`, so health owns no reception import. */
export interface PingableStorage {
  ping(): Promise<void>;
}

export const STORAGE_READINESS_TIMEOUT_MS = 2000;

/** Pings storage with a bounded wait. Failures map to `down`; error details are never exposed. */
export class StorageReadinessAdapter implements StorageReadinessPort {
  constructor(
    private readonly storage: PingableStorage | null,
    private readonly timeoutMs: number = STORAGE_READINESS_TIMEOUT_MS,
  ) {}

  async check(): Promise<StorageReadiness> {
    if (this.storage === null) {
      return 'skipped';
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('storage ping timed out'));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([this.storage.ping(), timeout]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
