import {
  EkuatiaConsultError,
  type EkuatiaClient,
} from '../../application/ports/ekuatia-client.port.js';

/**
 * Real eKuatia host. Tests must always pass an explicit local `baseUrl`.
 */
export const DEFAULT_EKUATIA_BASE_URL = 'https://ekuatia.set.gov.py';

const DEFAULT_TIMEOUT_MS = 30_000;
const CDC_PATTERN = /^\d{44}$/;
const XML_ROOT_PATTERN = /^\s*(<\?xml[^>]*\?>\s*)?<rDE[\s>]/;

export interface EkuatiaHttpClientOptions {
  readonly baseUrl?: string;
  /** Total budget for the whole consultation, including reading both bodies. */
  readonly timeoutMs?: number;
  /** Forward the cookies set by the POST to the GET of the same consultation. Default: off. */
  readonly propagateCookies?: boolean;
  readonly fetch?: typeof fetch;
}

/**
 * Thin `fetch` client for the public eKuatia consultation by CDC.
 *
 * Contract, and what the committed captures (`test/fixtures/reception/ekuatia/v2026-Q3/*`
 * `requests.json`) back:
 * - `POST {base}/docs/documento-electronico` answered 200 `application/json;charset=UTF-8` with a
 *   JSON object whose root is `DE` (backed). The captures store only responses, so the request
 *   headers, the request body and the token field name are NOT verified: this client sends
 *   `{ cdc, recaptchaToken }` as JSON, which is an assumption to confirm with a human capture.
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
 * Errors carry only our stable codes: never site text, the token, the CDC, a URL or a cause.
 */
export class EkuatiaHttpClient implements EkuatiaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly propagateCookies: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EkuatiaHttpClientOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_EKUATIA_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.propagateCookies = options.propagateCookies ?? false;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async consultByCdc(input: { cdc: string; recaptchaToken: string }): Promise<{ xml: string }> {
    // Validated before building any URL: a CDC is digits only, so it cannot alter the path.
    if (!CDC_PATTERN.test(input.cdc) || input.recaptchaToken.trim() === '') {
      throw new EkuatiaConsultError('consult_error');
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    const jar = new Map<string, string>();
    try {
      const post = await this.send(
        '/docs/documento-electronico',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cdc: input.cdc, recaptchaToken: input.recaptchaToken }),
        },
        signal,
        jar,
      );
      await post.arrayBuffer(); // drain; the JSON itself is not needed
      const get = await this.send(
        `/docs/documento-electronico-xml/${input.cdc}`,
        { method: 'GET' },
        signal,
        jar,
      );
      const xml = await get.text();
      if (!XML_ROOT_PATTERN.test(xml)) throw new EkuatiaConsultError('invalid_response');
      return { xml };
    } catch (error) {
      if (error instanceof EkuatiaConsultError) throw error;
      // Covers the deadline firing mid-flight or while reading a body. Other failures may echo
      // the URL, so they are never attached as a cause.
      throw new EkuatiaConsultError(signal.aborted ? 'timeout' : 'consult_error');
    }
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
    if (response.status === 404) throw new EkuatiaConsultError('not_found');
    if (response.status !== 200) throw new EkuatiaConsultError('consult_error');
    if (this.propagateCookies) {
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return response;
  }
}
