import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptchaSolveError } from '../../application/ports/captcha-solver.port.js';
import { DEFAULT_TWO_CAPTCHA_BASE_URL, TwoCaptchaSolver } from './two-captcha-solver.adapter.js';

const API_KEY = 'test-key-0123456789abcdef';
const INPUT = { sitekey: 'sitekey-abc', pageUrl: 'https://example.invalid/page' };

interface Seen {
  method: string;
  path: string;
  params: URLSearchParams;
}

type Reply = { status?: number; body: string };

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current)
    await new Promise<void>((resolve) =>
      current.close(() => {
        resolve();
      }),
    );
});

/** Local fake of the 2Captcha HTTP API; `handler` decides each reply from the request. */
async function startFake(
  handler: (seen: Seen, calls: Seen[]) => Reply,
): Promise<{ baseUrl: string; calls: Seen[] }> {
  const calls: Seen[] = [];
  const srv = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const seen = { method: req.method ?? '', path: url.pathname, params: url.searchParams };
    calls.push(seen);
    const reply = handler(seen, calls);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  server = srv;
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`, calls };
}

const json = (value: unknown): Reply => ({ body: JSON.stringify(value) });

function solver(baseUrl: string, extra: { timeoutMs?: number } = {}): TwoCaptchaSolver {
  return new TwoCaptchaSolver({ apiKey: API_KEY, baseUrl, pollIntervalMs: 5, ...extra });
}

async function failureOf(promise: Promise<unknown>): Promise<CaptchaSolveError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CaptchaSolveError);
  return error as CaptchaSolveError;
}

describe('TwoCaptchaSolver', () => {
  it('submits then polls until ready and returns the token', async () => {
    const { baseUrl, calls } = await startFake((seen) =>
      seen.path === '/in.php'
        ? json({ status: 1, request: '777' })
        : json({ status: 1, request: 'TOKEN-1' }),
    );

    await expect(solver(baseUrl).solveRecaptchaV2(INPUT)).resolves.toBe('TOKEN-1');

    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe('/in.php');
    expect(Object.fromEntries(calls[0].params)).toMatchObject({
      key: API_KEY,
      method: 'userrecaptcha',
      googlekey: INPUT.sitekey,
      pageurl: INPUT.pageUrl,
      json: '1',
    });
    expect(calls[1].path).toBe('/res.php');
    expect(Object.fromEntries(calls[1].params)).toMatchObject({
      key: API_KEY,
      action: 'get',
      id: '777',
      json: '1',
    });
  });

  it('keeps polling while the captcha is not ready', async () => {
    const { baseUrl, calls } = await startFake((seen, all) => {
      if (seen.path === '/in.php') return json({ status: 1, request: '9' });
      const polls = all.filter((c) => c.path === '/res.php').length;
      return polls < 3
        ? json({ status: 0, request: 'CAPCHA_NOT_READY' })
        : json({ status: 1, request: 'TOKEN-2' });
    });

    await expect(solver(baseUrl).solveRecaptchaV2(INPUT)).resolves.toBe('TOKEN-2');
    expect(calls.filter((c) => c.path === '/res.php')).toHaveLength(3);
  });

  it('times out when the captcha never becomes ready', async () => {
    const { baseUrl } = await startFake((seen) =>
      seen.path === '/in.php'
        ? json({ status: 1, request: '9' })
        : json({ status: 0, request: 'CAPCHA_NOT_READY' }),
    );

    const error = await failureOf(solver(baseUrl, { timeoutMs: 60 }).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('timeout');
  });

  it.each([
    ['ERROR_WRONG_USER_KEY', 'not_configured'],
    ['ERROR_KEY_DOES_NOT_EXIST', 'not_configured'],
    ['ERROR_ZERO_BALANCE', 'provider_error'],
    ['ERROR_NO_SLOT_AVAILABLE', 'provider_error'],
    ['ERROR_GOOGLEKEY', 'provider_error'],
    ['SOMETHING_NEW', 'provider_error'],
    ['ERROR_CAPTCHA_UNSOLVABLE', 'unsolvable'],
  ])('maps a submit error %s to %s', async (provider, code) => {
    const { baseUrl } = await startFake(() => json({ status: 0, request: provider }));
    const error = await failureOf(solver(baseUrl).solveRecaptchaV2(INPUT));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(provider);
  });

  it('maps an unsolvable error reported while polling', async () => {
    const { baseUrl } = await startFake((seen) =>
      seen.path === '/in.php'
        ? json({ status: 1, request: '9' })
        : json({ status: 0, request: 'ERROR_CAPTCHA_UNSOLVABLE' }),
    );
    const error = await failureOf(solver(baseUrl).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('unsolvable');
  });

  it('reports no_token when ready carries an empty token', async () => {
    const { baseUrl } = await startFake((seen) =>
      seen.path === '/in.php'
        ? json({ status: 1, request: '9' })
        : json({ status: 1, request: '' }),
    );
    const error = await failureOf(solver(baseUrl).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('no_token');
  });

  it.each([
    ['non JSON body', { body: '<html>oops</html>' }],
    ['HTTP 500', { status: 500, body: '{"status":1,"request":"9"}' }],
    ['unexpected JSON shape', { body: '{"foo":1}' }],
  ] as [string, Reply][])('maps %s to provider_error', async (_name, reply) => {
    const { baseUrl } = await startFake(() => reply);
    const error = await failureOf(solver(baseUrl).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('provider_error');
  });

  it('maps a network failure to provider_error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect failed key=${API_KEY}`));
    const s = new TwoCaptchaSolver({
      apiKey: API_KEY,
      baseUrl: 'http://127.0.0.1:1',
      pollIntervalMs: 1,
      fetch: fetchImpl,
    });
    const error = await failureOf(s.solveRecaptchaV2(INPUT));
    expect(error.code).toBe('provider_error');
    expect(error.cause).toBeUndefined();
  });

  it('rejects an empty api key at construction', () => {
    for (const apiKey of ['', '   ']) {
      try {
        new TwoCaptchaSolver({ apiKey, baseUrl: 'http://127.0.0.1:1' });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CaptchaSolveError);
        expect((e as CaptchaSolveError).code).toBe('not_configured');
      }
    }
  });

  it('never leaks the api key through the error', async () => {
    const { baseUrl } = await startFake(() =>
      json({ status: 0, request: `ERROR_ZERO_BALANCE ${API_KEY}` }),
    );
    const error = await failureOf(solver(baseUrl).solveRecaptchaV2(INPUT));
    const dump = [
      error.message,
      error.stack,
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      String(error.cause),
    ].join('\n');
    expect(dump).not.toContain(API_KEY);
  });

  it('defaults to the real service URL, which tests must never reach', async () => {
    expect(DEFAULT_TWO_CAPTCHA_BASE_URL).toBe('https://2captcha.com');
    const fetchImpl = vi.fn();
    new TwoCaptchaSolver({ apiKey: API_KEY, fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    // Guard: the suite fails if the default URL is ever used with the real fetch.
    const guarded = vi.fn((input: string | URL | Request) => {
      if (
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).startsWith(DEFAULT_TWO_CAPTCHA_BASE_URL)
      ) {
        throw new Error('test attempted to reach the real captcha service');
      }
      return Promise.reject(new Error('unreachable'));
    });
    const s = new TwoCaptchaSolver({ apiKey: API_KEY, fetch: guarded });
    await failureOf(s.solveRecaptchaV2(INPUT));
    expect(guarded).toHaveBeenCalled();
  });
});
