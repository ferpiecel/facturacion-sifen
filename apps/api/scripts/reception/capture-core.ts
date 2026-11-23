/**
 * Pure and injectable core of the human-run eKuatia capture (R6.4). Nothing here reads the
 * environment or the disk on its own: the entrypoint (`capture-ekuatia.ts`) wires `fetch`, the
 * captcha solver and the file system, so every branch is testable with in-memory doubles.
 *
 * Unlike the committed captures (responses only), each record also stores the REQUEST side:
 * method, URL, the headers we sent (cookie values redacted, names kept) and the body (captcha
 * token redacted).
 */
import type { CaptchaSolver } from '../../src/modules/reception/application/ports/captcha-solver.port.js';

export const CAPTURE_HOSTS = ['ekuatia.set.gov.py', '2captcha.com'] as const;
/** Public reCAPTCHA v2 site key of the consulta page (reference implementation; not a secret). */
export const EKUATIA_RECAPTCHA_SITEKEY = '6Ldcb-wrAAAAAGp5mRQLnbGW0GFsKyi71OhYDImu';
export const EKUATIA_CONSULTA_PAGE_URL = 'https://ekuatia.set.gov.py/consultas/';
const EKUATIA_BASE_URL = 'https://ekuatia.set.gov.py';
const REDACTED = '<redacted>';
const CDC_PATTERN = /^\d{44}$/;
const LABEL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMEOUT_MS = 30_000;

export interface CaptureArgs {
  readonly cdc?: string;
  readonly label: string;
  readonly out: string;
  readonly iAmAHuman: boolean;
  readonly yes: boolean;
  readonly skipCookieControl: boolean;
  /** Send a deliberately invalid token to see how a rejected captcha looks. Spends nothing. */
  readonly probeRejectedCaptcha: boolean;
}

export function parseCaptureArgs(argv: readonly string[]): CaptureArgs {
  const args = {
    cdc: undefined as string | undefined,
    label: 'success',
    out: './.captures',
    iAmAHuman: false,
    yes: false,
    skipCookieControl: false,
    probeRejectedCaptcha: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--i-am-a-human') args.iAmAHuman = true;
    else if (flag === '--yes') args.yes = true;
    else if (flag === '--skip-cookie-control') args.skipCookieControl = true;
    else if (flag === '--probe-rejected-captcha') args.probeRejectedCaptcha = true;
    else if (flag === '--cdc' || flag === '--label' || flag === '--out') {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${flag}`);
      const value = argv[(i += 1)] ?? '';
      if (flag === '--cdc') args.cdc = value;
      else if (flag === '--label') args.label = value;
      else args.out = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Static guards, evaluated before anything else (and before the API key is read). */
export function checkGuards(args: CaptureArgs, env: { readonly CI?: string }): GuardResult {
  if (env.CI !== undefined && env.CI !== '') {
    return { ok: false, reason: 'Refusing to run: CI is set. This script is human-run only.' };
  }
  if (!args.iAmAHuman) {
    return { ok: false, reason: 'Refusing to run without the explicit --i-am-a-human flag.' };
  }
  if (!LABEL_PATTERN.test(args.label)) {
    return { ok: false, reason: 'Invalid --label: only letters, digits, "_" and "-" are allowed.' };
  }
  if (args.cdc === undefined || !CDC_PATTERN.test(args.cdc)) {
    return { ok: false, reason: 'Missing or invalid --cdc: exactly 44 digits are required.' };
  }
  return { ok: true };
}

export function versionLabel(date: Date): string {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `v${String(date.getUTCFullYear())}-Q${String(quarter)}`;
}

export function redactCookieHeader(value: string): string {
  return value
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => `${pair.split('=', 1)[0] ?? ''}=${REDACTED}`)
    .join('; ');
}

/** Keeps the cookie name and attributes (path, HttpOnly...), drops the value. */
export function redactSetCookie(value: string): string {
  const [pair = '', ...attributes] = value.split(';');
  return [`${pair.split('=', 1)[0] ?? ''}=${REDACTED}`, ...attributes.map((a) => a.trim())].join(
    '; ',
  );
}

export interface Secret {
  readonly value: string;
  readonly label: string;
}

export function redactSecrets(text: string, secrets: readonly Secret[]): string {
  let out = text;
  for (const { value, label } of secrets) {
    if (value === '') continue;
    for (const form of new Set([
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ])) {
      out = out.split(form).join(`<${label}>`);
    }
  }
  return out;
}

export interface CaptureRecord {
  url: string;
  method: string;
  status_code?: number;
  headers?: Record<string, string>;
  set_cookie?: string[];
  body?: string;
  error?: string;
  note: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    cookie_names: string[];
    body: string | null;
  };
}

export interface CaptureResult {
  readonly records: CaptureRecord[];
  readonly documentXml?: string;
  readonly meta: Record<string, unknown>;
}

export interface RunCaptureInput {
  readonly cdc: string;
  readonly fetch: typeof fetch;
  /** Required unless `probeRejectedCaptcha` is set. */
  readonly solver?: CaptchaSolver;
  readonly apiKey?: string;
  readonly skipCookieControl: boolean;
  readonly probeRejectedCaptcha?: boolean;
  readonly label?: string;
  readonly now?: () => Date;
}

/** ONE consultation: solve once, POST, then GET (without cookies, then with them as a control). */
export async function runCapture(input: RunCaptureInput): Promise<CaptureResult> {
  const now = (input.now ?? (() => new Date()))();
  const probe = input.probeRejectedCaptcha === true;
  const token = probe ? 'invalid-token-probe-no-captcha-was-solved' : await solve(input.solver);
  const secrets: Secret[] = [
    { value: token, label: 'captcha-token' },
    { value: input.apiKey ?? '', label: 'api-key' },
  ];
  const records: CaptureRecord[] = [];
  const jar = new Map<string, string>();

  const send = async (
    note: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<CaptureRecord> => {
    const url = `${EKUATIA_BASE_URL}${path}`;
    const cookieNames = Object.keys(headers).some((h) => h.toLowerCase() === 'cookie')
      ? [...jar.keys()]
      : [];
    const safeHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        name.toLowerCase() === 'cookie' ? redactCookieHeader(value) : redactSecrets(value, secrets),
      ]),
    );
    const record: CaptureRecord = {
      url,
      method,
      note,
      request: {
        method,
        url,
        headers: safeHeaders,
        cookie_names: cookieNames,
        body: body === undefined ? null : redactSecrets(body, secrets),
      },
    };
    records.push(record);
    try {
      const response = await input.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      const setCookies = response.headers.getSetCookie();
      for (const cookie of setCookies) {
        const pair = cookie.split(';', 1)[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      record.status_code = response.status;
      record.headers = Object.fromEntries(
        [...response.headers].filter(([name]) => name.toLowerCase() !== 'set-cookie'),
      );
      record.set_cookie = setCookies.map(redactSetCookie);
      record.body = redactSecrets(text, secrets);
      (record as { rawText?: string }).rawText = text;
    } catch (error) {
      record.error = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    }
    return record;
  };

  const post = await send(
    'POST with the captcha token (request side UNVERIFIED before this capture)',
    'POST',
    '/docs/documento-electronico',
    { 'content-type': 'application/json' },
    JSON.stringify({ cdc: input.cdc, captcha: token }),
  );
  let documentXml: string | undefined;
  let cookieControl = false;
  if (post.status_code === 200) {
    const xmlPath = `/docs/documento-electronico-xml/${input.cdc}`;
    const plain = await send('GET without cookies', 'GET', xmlPath, {});
    documentXml = takeRawText(plain);
    if (!input.skipCookieControl && jar.size > 0) {
      cookieControl = true;
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const withCookies = await send('GET with the cookies set by the POST', 'GET', xmlPath, {
        cookie,
      });
      documentXml ??= takeRawText(withCookies);
    }
  }
  for (const record of records) delete (record as { rawText?: string }).rawText;
  return {
    records,
    documentXml,
    meta: {
      cdc: input.cdc,
      label: input.label ?? 'success',
      version: versionLabel(now),
      timestamp: now.toISOString(),
      cookie_control: cookieControl,
      probe_rejected_captcha: probe,
      captcha_token_length: token.length,
    },
  };
}

async function solve(solver: CaptchaSolver | undefined): Promise<string> {
  if (solver === undefined) throw new Error('A captcha solver is required.');
  return solver.solveRecaptchaV2({
    sitekey: EKUATIA_RECAPTCHA_SITEKEY,
    pageUrl: EKUATIA_CONSULTA_PAGE_URL,
  });
}

function takeRawText(record: CaptureRecord): string | undefined {
  const raw = (record as { rawText?: string }).rawText;
  return record.status_code === 200 &&
    raw !== undefined &&
    /^\s*(<\?xml[^>]*\?>\s*)?<rDE[\s>]/.test(raw)
    ? raw
    : undefined;
}
