import {
  CaptchaSolveError,
  type CaptchaSolver,
} from '../../application/ports/captcha-solver.port.js';

/**
 * Real 2Captcha endpoint. Tests must always pass an explicit local `baseUrl`.
 */
export const DEFAULT_TWO_CAPTCHA_BASE_URL = 'https://2captcha.com';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface TwoCaptchaSolverOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * Thin `fetch` client for the 2Captcha classic HTTP API (reCAPTCHA v2, proxyless).
 *
 * Contract implemented (NOT verified against the live service in this repository; the product
 * owner verified it manually through the contahelper integration, which uses the
 * `2captcha-python` SDK `recaptcha(sitekey, url)` call that speaks this same protocol):
 *
 * - Submit: `GET {base}/in.php?key=..&method=userrecaptcha&googlekey=..&pageurl=..&json=1`.
 *   Reply `{ "status": 1, "request": "<task id>" }`, or `{ "status": 0, "request": "ERROR_..." }`.
 * - Poll: `GET {base}/res.php?key=..&action=get&id=<task id>&json=1`. Reply
 *   `{ "status": 0, "request": "CAPCHA_NOT_READY" }` while solving (keep polling),
 *   `{ "status": 1, "request": "<g-recaptcha-response token>" }` when ready, or an
 *   `ERROR_...` code with `status: 0`.
 *
 * Provider text is never surfaced: errors carry only our own stable codes, and the API key
 * is never placed in a message, cause or property.
 */
export class TwoCaptchaSolver implements CaptchaSolver {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TwoCaptchaSolverOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '')
      throw new CaptchaSolveError('not_configured');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_TWO_CAPTCHA_BASE_URL).replace(/\/+$/, '');
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async solveRecaptchaV2(input: { sitekey: string; pageUrl: string }): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    const taskId = await this.submit(input, deadline);
    for (;;) {
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) throw new CaptchaSolveError('timeout');
      const reply = await this.call('/res.php', { action: 'get', id: taskId }, deadline);
      if (reply.status === 1) {
        if (reply.request === '') throw new CaptchaSolveError('no_token');
        return reply.request;
      }
      if (reply.request !== 'CAPCHA_NOT_READY') throw mapProviderError(reply.request);
    }
  }

  private async submit(
    input: { sitekey: string; pageUrl: string },
    deadline: number,
  ): Promise<string> {
    const reply = await this.call(
      '/in.php',
      { method: 'userrecaptcha', googlekey: input.sitekey, pageurl: input.pageUrl },
      deadline,
    );
    if (reply.status !== 1) throw mapProviderError(reply.request);
    if (reply.request === '') throw new CaptchaSolveError('provider_error');
    return reply.request;
  }

  private async call(
    path: string,
    params: Record<string, string>,
    deadline: number,
  ): Promise<{ status: number; request: string }> {
    const query = new URLSearchParams({ key: this.apiKey, ...params, json: '1' });
    let body: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}?${query.toString()}`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!response.ok) throw new CaptchaSolveError('provider_error');
      body = await response.json();
    } catch (error) {
      if (error instanceof CaptchaSolveError) throw error;
      // The abort signal also covers reading the body. Other failures may echo the URL (key),
      // so they are never attached as a cause.
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new CaptchaSolveError('timeout');
      }
      throw new CaptchaSolveError('provider_error');
    }
    return parseReply(body);
  }
}

function parseReply(body: unknown): { status: number; request: string } {
  if (typeof body !== 'object' || body === null) throw new CaptchaSolveError('provider_error');
  const { status, request } = body as { status?: unknown; request?: unknown };
  if (typeof status !== 'number' || (typeof request !== 'string' && typeof request !== 'number')) {
    throw new CaptchaSolveError('provider_error');
  }
  return { status, request: String(request) };
}

function mapProviderError(code: string): CaptchaSolveError {
  if (code.startsWith('ERROR_WRONG_USER_KEY') || code.startsWith('ERROR_KEY_DOES_NOT_EXIST')) {
    return new CaptchaSolveError('not_configured');
  }
  if (code.startsWith('ERROR_CAPTCHA_UNSOLVABLE')) return new CaptchaSolveError('unsolvable');
  return new CaptchaSolveError('provider_error');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
