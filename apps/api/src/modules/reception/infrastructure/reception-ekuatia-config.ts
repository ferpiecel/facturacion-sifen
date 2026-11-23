/**
 * Settings of the lookup by CDC (reception R6.3, ADR-0027), read from the environment. Invalid
 * values fail the boot; messages name variables, never their values.
 */
export interface ReceptionEkuatiaConfig {
  /** Kill switch (`RECEPTION_EKUATIA_ENABLED`). Off by default. */
  readonly enabled: boolean;
  /** `enabled` AND a solver key: the only state in which a lookup can run. */
  readonly available: boolean;
  /** `null` when `TWOCAPTCHA_API_KEY` is absent. Never log or echo it. */
  readonly solverApiKey: string | null;
  /** Paid solves one tenant may queue per UTC day. */
  readonly tenantDailySolveCap: number;
  /** Paid solves all tenants together may queue per UTC day. */
  readonly globalDailySolveCap: number;
  readonly breakerFailureThreshold: number;
  readonly breakerCooldownMs: number;
  /** eKuatia host, without trailing slash (UNVERIFIED against the live site: keep configurable). */
  readonly baseUrl: string;
  /** Public reCAPTCHA v2 site key of the consultation page (UNVERIFIED: keep configurable). */
  readonly sitekey: string;
}

/**
 * Defaults are CONSERVATIVE PLACEHOLDERS the product owner must confirm (risk R-3): every lookup
 * costs one paid solve.
 */
export const DEFAULT_EKUATIA_TENANT_DAILY_SOLVE_CAP = 20;
export const DEFAULT_EKUATIA_GLOBAL_DAILY_SOLVE_CAP = 100;
export const DEFAULT_EKUATIA_BREAKER_FAILURES = 5;
export const DEFAULT_EKUATIA_BREAKER_COOLDOWN_MS = 900_000;
export const DEFAULT_EKUATIA_BASE_URL = 'https://ekuatia.set.gov.py';
/** Public key of the consultation page as found by the reference implementation; not a secret. */
export const DEFAULT_EKUATIA_RECAPTCHA_SITEKEY = '6Ldcb-wrAAAAAGp5mRQLnbGW0GFsKyi71OhYDImu';

const MAX_TENANT_CAP = 100_000;
const MAX_GLOBAL_CAP = 1_000_000;
const MAX_BREAKER_FAILURES = 100;
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 86_400_000;
const SITEKEY = /^[A-Za-z0-9_-]{20,128}$/;

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readInteger(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = read(env, name);
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) {
    throw new Error(`${name} must be an integer between ${String(min)} and ${String(max)}.`);
  }
  return parsed;
}

function readSwitch(env: Env, name: string): boolean {
  const value = read(env, name)?.toLowerCase();
  if (value === undefined || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw new Error(`${name} must be true or false.`);
}

function readBaseUrl(env: Env): string {
  const name = 'EKUATIA_BASE_URL';
  const value = read(env, name);
  if (value === undefined) return DEFAULT_EKUATIA_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an https URL.`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(`${name} must be an https URL without credentials.`);
  }
  return value.replace(/\/+$/, '');
}

export function loadReceptionEkuatiaConfig(env: Env): ReceptionEkuatiaConfig {
  const enabled = readSwitch(env, 'RECEPTION_EKUATIA_ENABLED');
  const solverApiKey = read(env, 'TWOCAPTCHA_API_KEY') ?? null;
  const tenantDailySolveCap = readInteger(
    env,
    'RECEPTION_EKUATIA_DAILY_SOLVE_CAP',
    DEFAULT_EKUATIA_TENANT_DAILY_SOLVE_CAP,
    1,
    MAX_TENANT_CAP,
  );
  const globalDailySolveCap = readInteger(
    env,
    'RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP',
    DEFAULT_EKUATIA_GLOBAL_DAILY_SOLVE_CAP,
    1,
    MAX_GLOBAL_CAP,
  );
  if (tenantDailySolveCap > globalDailySolveCap) {
    throw new Error(
      'RECEPTION_EKUATIA_DAILY_SOLVE_CAP must not exceed RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP.',
    );
  }
  const sitekey = read(env, 'EKUATIA_RECAPTCHA_SITEKEY') ?? DEFAULT_EKUATIA_RECAPTCHA_SITEKEY;
  if (!SITEKEY.test(sitekey)) throw new Error('EKUATIA_RECAPTCHA_SITEKEY is not a valid site key.');
  return {
    enabled,
    available: enabled && solverApiKey !== null,
    solverApiKey,
    tenantDailySolveCap,
    globalDailySolveCap,
    breakerFailureThreshold: readInteger(
      env,
      'RECEPTION_EKUATIA_BREAKER_FAILURES',
      DEFAULT_EKUATIA_BREAKER_FAILURES,
      1,
      MAX_BREAKER_FAILURES,
    ),
    breakerCooldownMs: readInteger(
      env,
      'RECEPTION_EKUATIA_BREAKER_COOLDOWN_MS',
      DEFAULT_EKUATIA_BREAKER_COOLDOWN_MS,
      MIN_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
    ),
    baseUrl: readBaseUrl(env),
    sitekey,
  };
}
