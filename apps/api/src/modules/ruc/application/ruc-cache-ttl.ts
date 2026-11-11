const DEFAULT_TTL_SECONDS = 86_400;
const MAX_TTL_SECONDS = 604_800;

/**
 * `RUC_CACHE_TTL_SECONDS`: seconds a `siConsRUC` answer stays fresh. Default one day, 0 turns the cache off,
 * at most one week (a taxpayer's status can change).
 * @throws Error when the value is not an integer in range, so the API fails at startup
 */
export function parseRucCacheTtl(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value > MAX_TTL_SECONDS) {
    throw new Error(
      `RUC_CACHE_TTL_SECONDS must be an integer between 0 and ${String(MAX_TTL_SECONDS)}`,
    );
  }
  return value;
}
