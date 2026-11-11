export type StorageReadiness = 'up' | 'down' | 'skipped';

/** Reports whether object storage is reachable; `skipped` when storage is not configured. */
export interface StorageReadinessPort {
  check(): Promise<StorageReadiness>;
}
