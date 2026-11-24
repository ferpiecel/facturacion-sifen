import {
  EkuatiaConsultError,
  type EkuatiaClient,
} from '../../application/ports/ekuatia-client.port.js';

/**
 * Real eKuatia host. Tests must always pass an explicit local `baseUrl`.
 */
export const DEFAULT_EKUATIA_BASE_URL = 'https://ekuatia.set.gov.py';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
/** Largest body (POST answer or XML) read. A SIFEN `rDE` is far smaller; this bounds memory. */
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;
const MAX_MAX_RESPONSE_BYTES = 100_000_000;
const CDC_PATTERN = /^\d{44}$/;
const XML_ROOT_PATTERN = /^\s*(<\?xml[^>]*\?>\s*)?<rDE[\s>]/;

export interface EkuatiaHttpClientOptions {
  readonly baseUrl?: string;
  /** Total budget for the whole consultation, including reading both bodies. */
  readonly timeoutMs?: number;
  /** Forward the cookies set by the POST to the GET of the same consultation. Default: off. */
  readonly propagateCookies?: boolean;
  /** Cap on each response body; a larger one is `invalid_response`. Default 5 MB. */
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

/**
 * Thin `fetch` client for the public eKuatia consultation by CDC.
 *
 * Contract, and what the committed captures (`test/fixtures/reception/ekuatia/v2026-Q3/*`
 * `requests.json`) back:
 * - `POST {base}/docs/documento-electronico` answered 200 `application/json;charset=UTF-8` with a
 *   JSON object whose root is `DE` (backed). The captures store only responses, so the request is
 *   NOT backed by them. The JSON body `{ "cdc": <cdc>, "captcha": <token> }` comes from the two
 *   reference implementations (facturaspy and contahelper, the latter a port of the former, so
 *   convention evidence and not independent proof). Both state their contract was never verified
 *   against live eKuatia, and neither is it here: request headers and body stay UNVERIFIED.
 * - `GET {base}/docs/documento-electronico-xml/{cdc}` answered 200 `application/xml` with the
 *   `rDE` document (backed). A 404 is not in the captures: it is mapped to `not_found` by
 *   convention, and so is a POST 404. How the site reports a rejected captcha is not captured, so
 *   it surfaces as `consult_error`.
 *
 * Cookies: both captured responses carry `set-cookie` (POST: a session cookie, a BIG-IP
 * persistence cookie and a `TS...` cookie; GET: the `TS...` cookie again), but the captures record
 * no request headers, so whether the site needs them replayed is unknown. Decision: do not
 * propagate by default (the previous implementation never did, and the safest jar is no jar).
 * `propagateCookies` enables a jar that lives for ONE `consultByCdc` call, holds only `name=value`
 * pairs, and is never persisted or shared between consultations or tenants. UNVERIFIED either way.
 *
 * The 200 answer of the POST is checked conservatively (`isPlausiblePostAnswer`): a JSON object
 * rooted at `DE`, as in the captures. Anything else, for example a captcha rejected with HTTP 200,
 * is `invalid_response` and the XML is never requested. How the site really reports a rejected
 * captcha is UNVERIFIED and awaits the human capture (R6.4); adjust that one function then.
 *
 * Errors carry only our stable codes: never site text, the token, the CDC, a URL or a cause.
 */
export class EkuatiaHttpClient implements EkuatiaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly propagateCookies: boolean;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EkuatiaHttpClientOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `timeoutMs must be a positive finite number of at most ${String(MAX_TIMEOUT_MS)}`,
      );
    }
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isFinite(maxResponseBytes) ||
      maxResponseBytes <= 0 ||
      maxResponseBytes > MAX_MAX_RESPONSE_BYTES
    ) {
      throw new RangeError(
        `maxResponseBytes must be a positive finite number of at most ${String(MAX_MAX_RESPONSE_BYTES)}`,
      );
    }
    this.maxResponseBytes = maxResponseBytes;
    this.baseUrl = (options.baseUrl ?? DEFAULT_EKUATIA_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.propagateCookies = options.propagateCookies ?? false;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async consultByCdc(input: {
    cdc: string;
    recaptchaToken: string;
    signal?: AbortSignal;
  }): Promise<{ xml: string }> {
    // Validated before building any URL: a CDC is digits only, so it cannot alter the path.
    if (!CDC_PATTERN.test(input.cdc) || input.recaptchaToken.trim() === '') {
      throw new EkuatiaConsultError('consult_error');
    }
    const caller = input.signal;
    if (caller?.aborted) throw new EkuatiaConsultError('aborted');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
    const jar = new Map<string, string>();
    try {
      const post = await this.send(
        '/docs/documento-electronico',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cdc: input.cdc, captcha: input.recaptchaToken }),
        },
        signal,
        jar,
      );
      if (!isPlausiblePostAnswer(await this.readBody(post))) {
        throw new EkuatiaConsultError('invalid_response');
      }
      const get = await this.send(
        `/docs/documento-electronico-xml/${input.cdc}`,
        { method: 'GET' },
        signal,
        jar,
      );
      const xml = await this.readBody(get);
      if (!XML_ROOT_PATTERN.test(xml)) throw new EkuatiaConsultError('invalid_response');
      return { xml };
    } catch (error) {
      if (error instanceof EkuatiaConsultError) throw error;
      // Covers the deadline firing mid-flight or while reading a body. Other failures may echo
      // the URL, so they are never attached as a cause.
      if (caller?.aborted) throw new EkuatiaConsultError('aborted');
      throw new EkuatiaConsultError(timeout.aborted ? 'timeout' : 'consult_error');
    }
  }

  /** Reads a body up to the cap; a larger one is cancelled and reported as invalid. */
  private async readBody(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new EkuatiaConsultError('invalid_response');
    }
    if (!response.body) return '';
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EkuatiaConsultError('invalid_response');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async send(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    signal: AbortSignal,
    jar: Map<string, string>,
  ): Promise<Response> {
    const headers = { ...init.headers };
    if (this.propagateCookies && jar.size > 0) {
      headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal,
      redirect: 'manual',
    });
    if (response.status !== 200) {
      // An unread body keeps the connection busy: release it.
      await response.body?.cancel().catch(() => undefined);
      throw new EkuatiaConsultError(response.status === 404 ? 'not_found' : 'consult_error');
    }
    if (this.propagateCookies) {
      for (const cookie of response.headers.getSetCookie()) storeCookie(jar, cookie, Date.now());
    }
    return response;
  }
}

/**
 * Whether the 200 answer of the POST looks like a lookup result: a JSON object rooted at `DE`
 * (what the captures show). The real contract, including how a rejected captcha is reported, is
 * UNVERIFIED until the human capture; this is the only place to relax or tighten.
 */
function isPlausiblePostAnswer(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const root = (value as Record<string, unknown>).DE;
  return typeof root === 'object' && root !== null && !Array.isArray(root);
}

/** Keeps `name=value` of a `Set-Cookie`; an expired cookie is not stored and removes an older one. */
function storeCookie(jar: Map<string, string>, setCookie: string, now: number): void {
  const [pair = '', ...attributes] = setCookie.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return;
  const name = pair.slice(0, eq).trim();
  let expired = false;
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? '' : attribute.slice(at + 1).trim();
    if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    if (key === 'expires' && maxAge === undefined) {
      const date = Date.parse(value);
      if (!Number.isNaN(date) && date <= now) expired = true;
    }
  }
  if (maxAge !== undefined) expired = maxAge <= 0;
  if (expired) jar.delete(name);
  else jar.set(name, pair.slice(eq + 1).trim());
}
