/** Vision extraction settings read from the environment (infrastructure concern only). */
export interface ReceptionExtractionConfig {
  /** `null` means extraction is disabled (not an error). Never log or echo it. */
  readonly apiKey: string | null;
  readonly model: string;
  /** `null` when the fallback is explicitly disabled (`none` or `off`). */
  readonly fallbackModel: string | null;
  /** Per-request timeout of the SDK call; the adapter owns retries, the SDK does none. */
  readonly timeoutMs: number;
  /** The single read of the auto-confirm threshold; feeds `ConfidencePolicy.create` (ADR-0026). */
  readonly autoConfirmThreshold: number;
  /** Jobs the worker runs at once; PDFium and jsqr are CPU-bound and single-threaded. */
  readonly concurrency: number;
}

/** Documented defaults (ADR-0026, decision Q2); overridable through the environment. */
export const DEFAULT_EXTRACTION_MODEL = 'claude-sonnet-5';
export const DEFAULT_EXTRACTION_FALLBACK_MODEL = 'claude-haiku-4-5';
export const DEFAULT_AUTO_CONFIRM_THRESHOLD = 0.85;
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 120_000;
export const DEFAULT_EXTRACTION_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const UNIT_INTERVAL = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readModel(env: Env, name: string, fallback: string): string {
  const value = read(env, name);
  if (value === undefined) return fallback;
  if (!MODEL_ID.test(value)) throw new Error(`${name} is not a valid model id.`);
  return value;
}

function readFallbackModel(env: Env): string | null {
  const name = 'RECEPTION_EXTRACTION_FALLBACK_MODEL';
  const value = read(env, name);
  if (value !== undefined && /^(?:none|off)$/i.test(value)) return null;
  return readModel(env, name, DEFAULT_EXTRACTION_FALLBACK_MODEL);
}

function readTimeoutMs(env: Env): number {
  const value = read(env, 'RECEPTION_EXTRACTION_TIMEOUT_MS');
  if (value === undefined) return DEFAULT_EXTRACTION_TIMEOUT_MS;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS)) {
    throw new Error(
      `RECEPTION_EXTRACTION_TIMEOUT_MS must be an integer between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}.`,
    );
  }
  return parsed;
}

function readConcurrency(env: Env): number {
  const value = read(env, 'RECEPTION_EXTRACTION_CONCURRENCY');
  if (value === undefined) return DEFAULT_EXTRACTION_CONCURRENCY;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= 1 && parsed <= MAX_CONCURRENCY)) {
    throw new Error(
      `RECEPTION_EXTRACTION_CONCURRENCY must be an integer between 1 and ${String(MAX_CONCURRENCY)}.`,
    );
  }
  return parsed;
}

/**
 * Reads only the auto-confirm threshold. The API process needs this single value (the correction
 * policy) and must not fail its boot on worker-only variables such as the timeout or the models.
 * It is also the single source of truth `loadReceptionExtractionConfig` reuses.
 */
export function loadAutoConfirmThreshold(env: Env): number {
  const value = read(env, 'RECEPTION_AUTO_CONFIRM_THRESHOLD');
  if (value === undefined) return DEFAULT_AUTO_CONFIRM_THRESHOLD;
  if (!UNIT_INTERVAL.test(value)) {
    throw new Error('RECEPTION_AUTO_CONFIRM_THRESHOLD must be a number between 0 and 1.');
  }
  return Number(value);
}

/**
 * Parses the extraction variables, failing fast on invalid values. A missing `ANTHROPIC_API_KEY`
 * disables extraction instead of failing. Error messages name variables, never their values.
 */
export function loadReceptionExtractionConfig(env: Env): ReceptionExtractionConfig {
  return {
    apiKey: read(env, 'ANTHROPIC_API_KEY') ?? null,
    model: readModel(env, 'RECEPTION_EXTRACTION_MODEL', DEFAULT_EXTRACTION_MODEL),
    fallbackModel: readFallbackModel(env),
    timeoutMs: readTimeoutMs(env),
    autoConfirmThreshold: loadAutoConfirmThreshold(env),
    concurrency: readConcurrency(env),
  };
}
