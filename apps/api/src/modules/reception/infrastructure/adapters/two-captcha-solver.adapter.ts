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
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

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
 * - Submit: `POST {base}/in.php` with a form body `key, method=userrecaptcha, googlekey, pageurl,
 *   json=1`. Reply `{ "status": 1, "request": "<task id>" }`, or `{ "status": 0, "request": "ERROR_..." }`.
 * - Poll: `POST {base}/res.php` with a form body `key, action=get, id=<task id>, json=1`. Reply
 *   `{ "status": 0, "request": "CAPCHA_NOT_READY" }` while solving (keep polling),
 *   `{ "status": 1, "request": "<g-recaptcha-response token>" }` when ready, or an
 *   `ERROR_...` code with `status: 0`.
 *
 * The key travels in the form body, never in the URL: a URL ends up in proxies, error messages and
 * logs. Both endpoints also accept GET; POST is used for that reason only.
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
    this.pollIntervalMs = boundedMs(
      'pollIntervalMs',
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    );
    this.timeoutMs = boundedMs(
      'timeoutMs',
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  async solveRecaptchaV2(input: {
    sitekey: string;
    pageUrl: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const caller = input.signal;
    if (caller?.aborted) throw new CaptchaSolveError('aborted');
    const deadline = Date.now() + this.timeoutMs;
    const taskId = await this.submit(input, deadline, caller);
    for (;;) {
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())), caller);
      if (caller?.aborted) throw new CaptchaSolveError('aborted');
      if (Date.now() >= deadline) throw new CaptchaSolveError('timeout');
      const reply = await this.call('/res.php', { action: 'get', id: taskId }, deadline, caller);
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
    caller: AbortSignal | undefined,
  ): Promise<string> {
    const reply = await this.call(
      '/in.php',
      { method: 'userrecaptcha', googlekey: input.sitekey, pageurl: input.pageUrl },
      deadline,
      caller,
    );
    if (reply.status !== 1) throw mapProviderError(reply.request);
    if (reply.request === '') throw new CaptchaSolveError('provider_error');
    return reply.request;
  }

  private async call(
    path: string,
    params: Record<string, string>,
    deadline: number,
    caller: AbortSignal | undefined,
  ): Promise<{ status: number; request: string }> {
    const form = new URLSearchParams({ key: this.apiKey, ...params, json: '1' });
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
    let body: unknown;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal,
      });
      if (!response.ok) {
        // Unread bodies keep the socket busy until garbage collection: release it.
        await response.body?.cancel().catch(() => undefined);
        throw new CaptchaSolveError('provider_error');
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof CaptchaSolveError) throw error;
      // The abort signal also covers reading the body. Other failures may echo the URL, so they
      // are never attached as a cause.
      if (caller?.aborted) throw new CaptchaSolveError('aborted');
      if (timeout.aborted) throw new CaptchaSolveError('timeout');
      throw new CaptchaSolveError('provider_error');
    }
    return parseReply(body);
  }
}

function boundedMs(name: string, value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be a positive finite number of at most ${String(max)}`);
  }
  return value;
}

function parseReply(body: unknown): { status: number; request: string } {
  if (typeof body !== 'object' || body === null) throw new CaptchaSolveError('provider_error');
  const { status, request } = body as { status?: unknown; request?: unknown };
  if (typeof status !== 'number' || (typeof request !== 'string' && typeof request !== 'number')) {
    throw new CaptchaSolveError('provider_error');
  }
  return { status, request: String(request) };
}

/** Provider codes arrive with or without the `ERROR_` prefix depending on the endpoint. */
function mapProviderError(code: string): CaptchaSolveError {
  const name = code.replace(/^ERROR_/, '');
  if (name.startsWith('WRONG_USER_KEY') || name.startsWith('KEY_DOES_NOT_EXIST')) {
    return new CaptchaSolveError('not_configured');
  }
  if (name.startsWith('CAPTCHA_UNSOLVABLE')) return new CaptchaSolveError('unsolvable');
  if (name.startsWith('ZERO_BALANCE')) return new CaptchaSolveError('insufficient_balance');
  if (name.startsWith('NO_SLOT_AVAILABLE')) return new CaptchaSolveError('no_capacity');
  if (name.startsWith('IP_NOT_ALLOWED')) return new CaptchaSolveError('ip_not_allowed');
  return new CaptchaSolveError('provider_error');
}

/** Resolves after `ms`, or early when the caller aborts (the caller then checks the signal). */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
