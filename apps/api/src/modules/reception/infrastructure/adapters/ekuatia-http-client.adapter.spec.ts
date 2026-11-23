import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EkuatiaConsultError } from '../../application/ports/ekuatia-client.port.js';
import { DEFAULT_EKUATIA_BASE_URL, EkuatiaHttpClient } from './ekuatia-http-client.adapter.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../test/fixtures/reception/ekuatia/v2026-Q3',
);
const CAPTURES = ['success', 'success_pago_credito', 'servicio_digital'] as const;
const TOKEN = 'recaptcha-token-SECRET-0123456789';
const CDC = '00000000000000000000000000000000000000000001';
/** Shape of the captured POST answer: a JSON object rooted at `DE` (see the client docstring). */
const POST_OK = JSON.stringify({ DE: { Id: CDC } });

interface Capture {
  cdc: string;
  postResponse: string;
  xml: string;
  setCookie: string[];
}

function loadCapture(label: string): Capture {
  const dir = join(FIXTURES, label);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { cdc: string };
  const requests = Object.values(
    JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf8')) as Record<
      string,
      { method: string; body: string; headers: Record<string, string> }
    >,
  );
  const post = requests.find((r) => r.method === 'POST');
  if (!post) throw new Error('capture without POST');
  return {
    cdc: meta.cdc,
    postResponse: post.body,
    xml: readFileSync(join(dir, 'documento.xml'), 'utf8'),
    // Cookie names and values as recorded in the capture (anonymised session cookies).
    setCookie: ['sess=abc123; path=/; HttpOnly', 'TS0151e35c=ts-value; Path=/'],
  };
}

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
type Handler = (seen: Seen, index: number) => { status?: number; body?: string; stall?: boolean };

let server: Server | undefined;

// Safety net: any request that is not to the local fake fails the test instead of leaving the box.
beforeEach(() => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    if (!input.startsWith('http://127.0.0.1:')) {
      return Promise.reject(new Error('test attempted a non-local request'));
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const current = server;
  server = undefined;
  if (current) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => {
      current.close(() => {
        resolve();
      });
    });
  }
});

async function startFake(
  handler: Handler,
  delayMs = 0,
): Promise<{ baseUrl: string; calls: Seen[] }> {
  const calls: Seen[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw,
      };
      calls.push(seen);
      const reply = handler(seen, calls.length - 1);
      const send = (): void => {
        if (reply.stall) {
          res.writeHead(200, { 'content-type': 'application/xml' });
          res.write('<rDE');
          return;
        }
        res.writeHead(reply.status ?? 200, {
          'content-type': seen.method === 'POST' ? 'application/json' : 'application/xml',
        });
        res.end(reply.body ?? '');
      };
      if (delayMs) setTimeout(send, delayMs);
      else send();
    });
  });
  server = srv;
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`, calls };
}

/** Replays one capture: POST answers the recorded JSON with cookies, GET answers the XML. */
function replay(capture: Capture): Handler {
  return (seen) =>
    seen.method === 'POST' ? { body: capture.postResponse } : { body: capture.xml };
}

async function failureOf(promise: Promise<unknown>): Promise<EkuatiaConsultError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EkuatiaConsultError);
  return error as EkuatiaConsultError;
}

describe('EkuatiaHttpClient', () => {
  it.each(CAPTURES)('replays the %s capture and returns its XML', async (label) => {
    const capture = loadCapture(label);
    const { baseUrl, calls } = await startFake(replay(capture));
    const result = await new EkuatiaHttpClient({ baseUrl }).consultByCdc({
      cdc: capture.cdc,
      recaptchaToken: TOKEN,
    });
    expect(result.xml).toBe(capture.xml);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /docs/documento-electronico',
      `GET /docs/documento-electronico-xml/${capture.cdc}`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ cdc: capture.cdc, captcha: TOKEN });
  });

  it('maps a 404 to not_found', async () => {
    const { baseUrl } = await startFake((s) =>
      s.method === 'POST' ? { body: POST_OK } : { status: 404 },
    );
    const error = await failureOf(
      new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN }),
    );
    expect(error.code).toBe('not_found');
  });

  it('maps a 404 on the POST to not_found', async () => {
    const { baseUrl } = await startFake(() => ({ status: 404 }));
    const error = await failureOf(
      new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN }),
    );
    expect(error.code).toBe('not_found');
  });

  it.each([400, 403, 500, 503])('maps status %i to consult_error', async (status) => {
    const { baseUrl } = await startFake(() => ({ status, body: `raw site text ${TOKEN}` }));
    const error = await failureOf(
      new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN }),
    );
    expect(error.code).toBe('consult_error');
    expect(error.message).not.toContain('raw site text');
  });

  it.each(['', '   \n', '<html>captcha</html>'])(
    'maps a non-XML or empty body %j to invalid_response',
    async (body) => {
      const { baseUrl } = await startFake((s) =>
        s.method === 'POST' ? { body: POST_OK } : { body },
      );
      const error = await failureOf(
        new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN }),
      );
      expect(error.code).toBe('invalid_response');
    },
  );

  it('times out while the server is slow to answer', async () => {
    const { baseUrl } = await startFake(() => ({ body: '{}' }), 300);
    const error = await failureOf(
      new EkuatiaHttpClient({ baseUrl, timeoutMs: 50 }).consultByCdc({
        cdc: CDC,
        recaptchaToken: TOKEN,
      }),
    );
    expect(error.code).toBe('timeout');
  });

  it('times out while reading a stalled body', async () => {
    const { baseUrl } = await startFake((s) =>
      s.method === 'POST' ? { body: POST_OK } : { stall: true },
    );
    const error = await failureOf(
      new EkuatiaHttpClient({ baseUrl, timeoutMs: 100 }).consultByCdc({
        cdc: CDC,
        recaptchaToken: TOKEN,
      }),
    );
    expect(error.code).toBe('timeout');
  });

  it.each(['', '123', `${CDC}0`, '../../etc/passwd', `${CDC.slice(0, 43)}x`, `${CDC}/../x`])(
    'rejects cdc %j without touching the network',
    async (cdc) => {
      const { baseUrl, calls } = await startFake(() => ({}));
      const error = await failureOf(
        new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc, recaptchaToken: TOKEN }),
      );
      expect(error.code).toBe('consult_error');
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects an empty recaptcha token without touching the network', async () => {
    const { baseUrl, calls } = await startFake(() => ({}));
    const error = await failureOf(
      new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc: CDC, recaptchaToken: ' ' }),
    );
    expect(error.code).toBe('consult_error');
    expect(calls).toHaveLength(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects timeoutMs %s', (timeoutMs) => {
    expect(() => new EkuatiaHttpClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs })).toThrow(
      RangeError,
    );
  });

  it('never reaches the real host by default and never leaks the token in errors', async () => {
    const urls: string[] = [];
    const spy = ((input: unknown): Promise<Response> => {
      urls.push(String(input));
      return Promise.reject(new Error(`network down ${TOKEN}`));
    }) as typeof fetch;
    const error = await failureOf(
      new EkuatiaHttpClient({ fetch: spy }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN }),
    );
    expect(urls).toHaveLength(1);
    expect(DEFAULT_EKUATIA_BASE_URL).toBe('https://ekuatia.set.gov.py');
    expect(urls[0]?.startsWith('https://ekuatia.set.gov.py/')).toBe(true);
    expect(error.code).toBe('consult_error');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(CDC);
    expect(error.cause).toBeUndefined();
  });

  describe('cookies (unverified: the captures record no request headers)', () => {
    async function startCookieFake(
      capture: Capture,
      setCookie: string[] = capture.setCookie,
    ): Promise<{ baseUrl: string; calls: Seen[] }> {
      const calls: Seen[] = [];
      const srv = createServer((req, res) => {
        calls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body: '',
        });
        req.resume();
        req.on('end', () => {
          if (req.method === 'POST') {
            res.writeHead(200, {
              'content-type': 'application/json',
              'set-cookie': setCookie,
            });
            res.end(capture.postResponse);
          } else {
            res.writeHead(200, { 'content-type': 'application/xml' });
            res.end(capture.xml);
          }
        });
      });
      server = srv;
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      return { baseUrl: `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`, calls };
    }

    it('does not forward site cookies by default', async () => {
      const capture = loadCapture('success');
      const { baseUrl, calls } = await startCookieFake(capture);
      await new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN });
      expect(calls[1]?.headers.cookie).toBeUndefined();
    });

    it('forwards POST cookies to the GET of the same query only when enabled', async () => {
      const capture = loadCapture('success');
      const { baseUrl, calls } = await startCookieFake(capture);
      const client = new EkuatiaHttpClient({ baseUrl, propagateCookies: true });
      await client.consultByCdc({ cdc: CDC, recaptchaToken: TOKEN });
      await client.consultByCdc({ cdc: CDC, recaptchaToken: TOKEN });
      expect(calls[0]?.headers.cookie).toBeUndefined();
      expect(calls[1]?.headers.cookie).toBe('sess=abc123; TS0151e35c=ts-value');
      // The jar is per query: the second POST starts clean.
      expect(calls[2]?.headers.cookie).toBeUndefined();
    });

    it('ignores expired cookies and drops a cookie the site expires', async () => {
      const capture = loadCapture('success');
      const { baseUrl, calls } = await startCookieFake(capture, [
        'live=1; Path=/',
        'old=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
        'zero=3; Max-Age=0; Path=/',
        'timed=4; Max-Age=3600; Path=/',
      ]);
      await new EkuatiaHttpClient({ baseUrl, propagateCookies: true }).consultByCdc({
        cdc: CDC,
        recaptchaToken: TOKEN,
      });
      expect(calls[1]?.headers.cookie).toBe('live=1; timed=4');
    });
  });

  describe('POST answer validation (contract awaiting the human capture)', () => {
    it.each([
      ['empty body', ''],
      ['not JSON', '<html>captcha</html>'],
      ['a JSON array', '[]'],
      ['a JSON string', '"ok"'],
      ['an object without the DE root', '{"error":"captcha"}'],
      ['a DE that is not an object', '{"DE":"x"}'],
    ])('maps a 200 POST with %s to invalid_response without fetching the XML', async (_n, body) => {
      const { baseUrl, calls } = await startFake(() => ({ body }));
      const error = await failureOf(
        new EkuatiaHttpClient({ baseUrl }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN }),
      );
      expect(error.code).toBe('invalid_response');
      expect(calls.map((c) => c.method)).toEqual(['POST']);
    });
  });

  describe('size cap, aborts and unread bodies', () => {
    it('rejects an XML larger than the cap as invalid_response', async () => {
      const big = `<rDE>${'x'.repeat(5_000)}</rDE>`;
      const { baseUrl } = await startFake((s) =>
        s.method === 'POST' ? { body: POST_OK } : { body: big },
      );
      const error = await failureOf(
        new EkuatiaHttpClient({ baseUrl, maxResponseBytes: 1_000 }).consultByCdc({
          cdc: CDC,
          recaptchaToken: TOKEN,
        }),
      );
      expect(error.code).toBe('invalid_response');
    });

    it('accepts an XML right at the cap', async () => {
      const xml = `<rDE>${'x'.repeat(100)}</rDE>`; // longer than the POST answer: the cap is per body
      const { baseUrl } = await startFake((s) =>
        s.method === 'POST' ? { body: POST_OK } : { body: xml },
      );
      const result = await new EkuatiaHttpClient({
        baseUrl,
        maxResponseBytes: Buffer.byteLength(xml),
      }).consultByCdc({ cdc: CDC, recaptchaToken: TOKEN });
      expect(result.xml).toBe(xml);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100_000_001])(
      'rejects maxResponseBytes %s',
      (maxResponseBytes) => {
        expect(
          () => new EkuatiaHttpClient({ baseUrl: 'http://127.0.0.1:1', maxResponseBytes }),
        ).toThrow(RangeError);
      },
    );

    it('rejects a timeoutMs above the upper bound', () => {
      expect(
        () => new EkuatiaHttpClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 600_001 }),
      ).toThrow(RangeError);
    });

    it('does not touch the network when the caller signal is already aborted', async () => {
      const { baseUrl, calls } = await startFake(() => ({}));
      const error = await failureOf(
        new EkuatiaHttpClient({ baseUrl }).consultByCdc({
          cdc: CDC,
          recaptchaToken: TOKEN,
          signal: AbortSignal.abort(),
        }),
      );
      expect(error.code).toBe('aborted');
      expect(calls).toHaveLength(0);
    });

    it('maps a caller abort in flight to aborted, not timeout', async () => {
      const { baseUrl } = await startFake(() => ({ body: POST_OK }), 2_000);
      const controller = new AbortController();
      const pending = failureOf(
        new EkuatiaHttpClient({ baseUrl }).consultByCdc({
          cdc: CDC,
          recaptchaToken: TOKEN,
          signal: controller.signal,
        }),
      );
      setTimeout(() => {
        controller.abort();
      }, 30);
      expect((await pending).code).toBe('aborted');
    });

    it('cancels the body of a non-200 response it does not read', async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull() {
          /* never produces */
        },
        cancel() {
          cancelled = true;
        },
      });
      const fetchImpl = (() =>
        Promise.resolve(new Response(body, { status: 500 }))) as typeof fetch;
      const error = await failureOf(
        new EkuatiaHttpClient({ fetch: fetchImpl }).consultByCdc({
          cdc: CDC,
          recaptchaToken: TOKEN,
        }),
      );
      expect(error.code).toBe('consult_error');
      expect(cancelled).toBe(true);
    });
  });
});
