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
  /** Query string and form body merged: where a parameter travels is asserted via `query`. */
  params: URLSearchParams;
  query: URLSearchParams;
}

type Reply = { status?: number; body: string; delayMs?: number; stallBody?: boolean };

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
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const params = new URLSearchParams(url.searchParams);
      for (const [name, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
        params.set(name, value);
      }
      const seen = {
        method: req.method ?? '',
        path: url.pathname,
        params,
        query: url.searchParams,
      };
      calls.push(seen);
      const reply = handler(seen, calls);
      const send = (): void => {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        if (reply.stallBody) {
          res.write(reply.body.slice(0, 3)); // headers and a partial body, never finished
          return;
        }
        res.end(reply.body);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
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
  it('sends the api key in a POST form body, never in the URL', async () => {
    const { baseUrl, calls } = await startFake((seen) =>
      seen.path === '/in.php'
        ? json({ status: 1, request: '777' })
        : json({ status: 1, request: 'TOKEN-1' }),
    );

    await solver(baseUrl).solveRecaptchaV2(INPUT);

    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.params.get('key')).toBe(API_KEY);
      expect([...call.query.keys()]).toEqual([]);
    }
  });

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
    ['ERROR_ZERO_BALANCE', 'insufficient_balance'],
    ['ERROR_NO_SLOT_AVAILABLE', 'no_capacity'],
    ['NO_SLOT_AVAILABLE', 'no_capacity'],
    ['ERROR_IP_NOT_ALLOWED', 'ip_not_allowed'],
    ['IP_NOT_ALLOWED', 'ip_not_allowed'],
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

  it.each([[''], ['   '], [undefined], [null]])('rejects api key %j at construction', (apiKey) => {
    let thrown: unknown;
    try {
      new TwoCaptchaSolver({ apiKey: apiKey as unknown as string, baseUrl: 'http://127.0.0.1:1' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CaptchaSolveError);
    expect((thrown as CaptchaSolveError).code).toBe('not_configured');
  });

  it('times out when the provider is slower than the deadline (in flight)', async () => {
    const { baseUrl } = await startFake(() => ({ body: '{}', delayMs: 2_000 }));
    const error = await failureOf(solver(baseUrl, { timeoutMs: 80 }).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('timeout');
  });

  it('times out when the deadline hits while the body is being read', async () => {
    const { baseUrl } = await startFake(() => ({
      body: '{"status":1,"request":"9"}',
      stallBody: true,
    }));
    const error = await failureOf(solver(baseUrl, { timeoutMs: 80 }).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('timeout');
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

  it('uses the real service URL by default (spy fetch, never reaches the network)', async () => {
    expect(DEFAULT_TWO_CAPTCHA_BASE_URL).toBe('https://2captcha.com');
    const fetchImpl = vi.fn((input: string) =>
      Promise.reject(new Error(`blocked in tests: ${String(input.length)}`)),
    );
    const s = new TwoCaptchaSolver({
      apiKey: API_KEY,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const error = await failureOf(s.solveRecaptchaV2(INPUT));
    expect(error.code).toBe('provider_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${DEFAULT_TWO_CAPTCHA_BASE_URL}/in.php`);
  });

  it('rejects an empty task id as provider_error', async () => {
    const { baseUrl, calls } = await startFake(() => json({ status: 1, request: '' }));
    const error = await failureOf(solver(baseUrl).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('provider_error');
    expect(calls).toHaveLength(1);
  });

  it('maps a transport failure while polling to provider_error', async () => {
    const { baseUrl } = await startFake((seen) =>
      seen.path === '/in.php'
        ? json({ status: 1, request: '9' })
        : { status: 502, body: 'bad gateway' },
    );
    const error = await failureOf(solver(baseUrl).solveRecaptchaV2(INPUT));
    expect(error.code).toBe('provider_error');
  });

  it('never calls the provider when the caller signal is already aborted', async () => {
    const fetchImpl = vi.fn();
    const s = new TwoCaptchaSolver({
      apiKey: API_KEY,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const error = await failureOf(s.solveRecaptchaV2({ ...INPUT, signal: AbortSignal.abort() }));
    expect(error.code).toBe('aborted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops with aborted when the caller aborts while the provider is slow', async () => {
    const { baseUrl } = await startFake(() => ({ body: '{}', delayMs: 2_000 }));
    const controller = new AbortController();
    const pending = failureOf(
      solver(baseUrl).solveRecaptchaV2({ ...INPUT, signal: controller.signal }),
    );
    setTimeout(() => {
      controller.abort();
    }, 30);
    expect((await pending).code).toBe('aborted');
  });

  it('stops with aborted when the caller aborts between polls', async () => {
    const controller = new AbortController();
    const { baseUrl } = await startFake((seen) => {
      if (seen.path === '/in.php') return json({ status: 1, request: '9' });
      controller.abort();
      return json({ status: 0, request: 'CAPCHA_NOT_READY' });
    });
    const error = await failureOf(
      new TwoCaptchaSolver({ apiKey: API_KEY, baseUrl, pollIntervalMs: 5_000 }).solveRecaptchaV2({
        ...INPUT,
        signal: controller.signal,
      }),
    );
    expect(error.code).toBe('aborted');
  });

  it.each([
    [{ pollIntervalMs: 0 }],
    [{ pollIntervalMs: -1 }],
    [{ pollIntervalMs: Number.NaN }],
    [{ pollIntervalMs: Number.POSITIVE_INFINITY }],
    [{ pollIntervalMs: 60_001 }],
    [{ timeoutMs: 0 }],
    [{ timeoutMs: Number.NaN }],
    [{ timeoutMs: 600_001 }],
  ])('rejects invalid timing options %j at construction', (extra) => {
    expect(
      () => new TwoCaptchaSolver({ apiKey: API_KEY, baseUrl: 'http://127.0.0.1:1', ...extra }),
    ).toThrow(RangeError);
  });

  it('cancels the body of an error response it does not read', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        /* never produces: only cancel() settles it */
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(body, { status: 500 })));
    const s = new TwoCaptchaSolver({
      apiKey: API_KEY,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const error = await failureOf(s.solveRecaptchaV2(INPUT));
    expect(error.code).toBe('provider_error');
    expect(cancelled).toBe(true);
  });
});
