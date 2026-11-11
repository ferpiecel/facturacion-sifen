/** Vision extraction settings read from the environment (infrastructure concern only). */
export interface ReceptionExtractionConfig {
  /** `null` means extraction is disabled (not an error). Never log or echo it. */
  readonly apiKey: string | null;
  readonly model: string;
  /** `null` when no fallback is configured. */
  readonly fallbackModel: string | null;
  /** The single read of the auto-confirm threshold; feeds `ConfidencePolicy.create` (ADR-0026). */
  readonly autoConfirmThreshold: number;
}

/** Documented defaults (ADR-0026, decision Q2); overridable through the environment. */
export const DEFAULT_EXTRACTION_MODEL = 'claude-sonnet-5';
export const DEFAULT_EXTRACTION_FALLBACK_MODEL = 'claude-haiku-4-5';
export const DEFAULT_AUTO_CONFIRM_THRESHOLD = 0.85;

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

function readThreshold(env: Env): number {
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
    fallbackModel: readModel(
      env,
      'RECEPTION_EXTRACTION_FALLBACK_MODEL',
      DEFAULT_EXTRACTION_FALLBACK_MODEL,
    ),
    autoConfirmThreshold: readThreshold(env),
  };
}
