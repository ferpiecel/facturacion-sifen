export const DEFAULT_SYNC_WAIT_TIMEOUT_MS = 30_000;
const MIN_MS = 1_000;
const MAX_MS = 30_000;

/**
 * `SYNC_WAIT_TIMEOUT_MS` (HU-E6-06): how long `POST /v1/documents?wait=true` holds the response for a
 * tenant with synchronous transmission. 1000 to 30000, default 30000; anything else stops the boot.
 */
export function parseSyncWaitTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.SYNC_WAIT_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_SYNC_WAIT_TIMEOUT_MS;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value) || value < MIN_MS || value > MAX_MS) {
    throw new Error(
      `SYNC_WAIT_TIMEOUT_MS must be an integer from ${String(MIN_MS)} to ${String(MAX_MS)}.`,
    );
  }
  return value;
}
