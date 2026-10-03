import type { IncomingHttpHeaders } from 'node:http';
import { createServer, type Server } from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_TLS_CERT,
  TEST_TLS_HOST,
  TEST_TLS_KEY,
} from '../../../../test/support/webhook-tls-fixture.js';
import { SafeWebhookHttp } from './safe-webhook-http.js';

const err = (code: string) => ({ kind: 'error', code });
const go = (client: SafeWebhookHttp, url = 'https://h.example.com/') =>
  client.post({ url, headers: {}, body: '' });
const HEADERS = { 'content-type': 'application/json', 'sifen-signature': 't=1,v1=ab' };

describe('SafeWebhookHttp (HU-E11-01)', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function listen(handler: Parameters<typeof createServer>[1]) {
    const server = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler);
    servers.push(server);
    const sni: string[] = [];
    server.on('secureConnection', (s: TLSSocket) => sni.push(s.servername as string));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as AddressInfo).port, sni, server };
  }

  /** Resolves every name to loopback and trusts the fixture CA: the policy is lifted only for these. */
  const local = (over: ConstructorParameters<typeof SafeWebhookHttp>[0] = {}) =>
    new SafeWebhookHttp({
      resolve: () => Promise.resolve(['127.0.0.1']),
      isBlocked: () => false,
      ca: TEST_TLS_CERT,
      ...over,
    });
  const post = (client: SafeWebhookHttp, port: number, path = '/hook') =>
    client.post({
      url: `https://${TEST_TLS_HOST}:${String(port)}${path}`,
      headers: HEADERS,
      body: '{"id":"evt_1"}',
    });

  it.each([
    ['loopback', '127.0.0.1'],
    ['private 10/8', '10.1.2.3'],
    ['link-local metadata', '169.254.169.254'],
    ['IPv6 unique local', 'fd00::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ])('refuses a host resolving to %s without opening a connection', async (_name, address) => {
    const request = vi.fn();
    const client = new SafeWebhookHttp({ resolve: () => Promise.resolve([address]), request });
    expect(await go(client, 'https://hooks.example.com/x')).toEqual(err('blocked_address'));
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a host with even one blocked address among public ones', async () => {
    const client = new SafeWebhookHttp({
      resolve: () => Promise.resolve(['8.8.8.8', '10.0.0.1']),
      request: vi.fn(),
    });
    expect(await go(client, 'https://h.example.com/')).toEqual(err('blocked_address'));
  });

  it.each(['https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest'])(
    'refuses the IP literal %s without resolving it',
    async (url) => {
      const resolve = vi.fn();
      const client = new SafeWebhookHttp({ resolve, request: vi.fn() });
      expect(await go(client, url)).toEqual(err('blocked_address'));
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://example.com/x',
    'ftp://example.com',
    'https://user:pw@example.com/',
    'not a url',
    '',
  ])('rejects the url %j', async (url) => {
    const client = new SafeWebhookHttp({ resolve: vi.fn(), request: vi.fn() });
    expect(await go(client, url)).toEqual(err('invalid_url'));
  });

  it('classifies a failing or empty DNS answer', async () => {
    for (const resolve of [
      () => Promise.reject(new Error('ENOTFOUND')),
      () => Promise.resolve([]),
    ]) {
      const client = new SafeWebhookHttp({ resolve });
      expect(await go(client, 'https://h.example.com/')).toEqual(err('dns_failure'));
    }
  });

  it('re-resolves and re-checks on every attempt', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockResolvedValueOnce(['10.0.0.1']);
    const request = vi.fn(() => {
      throw new Error('boom');
    });
    const client = new SafeWebhookHttp({ resolve, request });
    const url = 'https://h.example.com/';
    expect(await go(client, url)).toMatchObject({ kind: 'error' });
    expect(await go(client, url)).toEqual(err('blocked_address'));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('POSTs the exact body and headers to the pinned address, with the original Host and SNI', async () => {
    const seen: { headers?: IncomingHttpHeaders; body?: string; method?: string; url?: string } =
      {};
    const { port, sni } = await listen((req, res) => {
      seen.headers = req.headers;
      seen.method = req.method;
      seen.url = req.url;
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.body = body;
        res.writeHead(204).end();
      });
    });
    expect(await post(local(), port, '/hook?a=1')).toEqual({ kind: 'response', status: 204 });
    expect(seen).toMatchObject({ method: 'POST', url: '/hook?a=1', body: '{"id":"evt_1"}' });
    expect(seen.headers).toMatchObject({
      host: `${TEST_TLS_HOST}:${String(port)}`,
      'content-type': 'application/json',
      'sifen-signature': 't=1,v1=ab',
      'content-length': '14',
    });
    expect(sni).toEqual([TEST_TLS_HOST]);
  });

  it('reports non-2xx statuses and never follows a redirect', async () => {
    let hits = 0;
    const { port } = await listen((_req, res) => {
      hits++;
      res.writeHead(302, { location: 'https://127.0.0.1/elsewhere' }).end();
    });
    expect(await post(local(), port)).toEqual({ kind: 'response', status: 302 });
    expect(hits).toBe(1);
  });

  it('times out a server that never answers', async () => {
    const { port } = await listen(() => undefined);
    expect(await post(local({ totalTimeoutMs: 150 }), port)).toEqual(err('timeout'));
  });

  it('stops reading an oversized response body at the cap', async () => {
    let finished = true;
    const { port } = await listen((_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(16 * 1024, 1);
      const timer = setInterval(() => res.write(chunk), 1);
      res.on('close', () => {
        finished = res.writableFinished;
        clearInterval(timer);
      });
    });
    expect(await post(local({ maxBodyBytes: 32 * 1024 }), port)).toEqual({
      kind: 'response',
      status: 200,
    });
    await vi.waitFor(() => {
      expect(finished).toBe(false);
    });
  });

  it('classifies an untrusted certificate and a refused connection', async () => {
    const { port } = await listen((_req, res) => res.end());
    expect(await post(local({ ca: undefined }), port)).toEqual(err('tls_failure'));
    const closed = (await listen(() => undefined)).server;
    const free = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    expect(await post(local(), free)).toEqual(err('connect_failed'));
  });

  it('bounds the DNS lookup by the total deadline', async () => {
    const client = new SafeWebhookHttp({
      resolve: () => new Promise(() => undefined),
      totalTimeoutMs: 100,
    });
    const started = Date.now();
    expect(await go(client)).toEqual(err('timeout'));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('ignores HTTPS_PROXY and NODE_USE_ENV_PROXY: the vetted address is connected to directly', async () => {
    let proxied = 0;
    const proxy = createNetServer(() => {
      proxied++;
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`);
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    try {
      const { port } = await listen((_req, res) => res.end());
      expect(await post(local(), port)).toEqual({ kind: 'response', status: 200 });
      expect(proxied).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await new Promise((r) => proxy.close(r));
    }
  });
});
