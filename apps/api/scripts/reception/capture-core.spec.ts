import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_HOSTS,
  checkGuards,
  parseCaptureArgs,
  isInsideVersionedTree,
  redactCookieHeader,
  redactSecrets,
  redactSetCookie,
  runCapture,
  versionLabel,
} from './capture-core.js';

const CDC = '01800000011001001000000122026012711234567894'.slice(0, 44);
const TOKEN = 'TOKEN-abc_123/xyz';
const API_KEY = 'KEY-do-not-leak-0001';

describe('parseCaptureArgs', () => {
  it('parses flags with defaults', () => {
    const args = parseCaptureArgs(['--cdc', CDC, '--i-am-a-human', '--yes']);
    expect(args).toMatchObject({ cdc: CDC, iAmAHuman: true, yes: true, label: 'success' });
    expect(args.out).toBe('./.captures');
  });

  it('rejects unknown flags', () => {
    expect(() => parseCaptureArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  it('ignores the bare -- separator that pnpm forwards to the script', () => {
    const args = parseCaptureArgs(['--', '--cdc', CDC, '--i-am-a-human']);
    expect(args.cdc).toBe(CDC);
    expect(args.iAmAHuman).toBe(true);
  });
});

describe('checkGuards', () => {
  const ok = {
    cdc: CDC,
    iAmAHuman: true,
    yes: false,
    label: 's',
    out: 'o',
    skipCookieControl: false,
    probeRejectedCaptcha: false,
  };

  it('passes for a human with a valid CDC outside CI', () => {
    expect(checkGuards(ok, {})).toEqual({ ok: true });
  });

  it.each(['true', '1', 'anything'])('refuses when CI=%s', (ci) => {
    const result = checkGuards(ok, { CI: ci });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/CI/);
  });

  it.each(['..', 'a/b', 'a\\b', '', 'has space', '../x', 'a.b'])('refuses label %j', (label) => {
    expect(checkGuards({ ...ok, label }, {}).ok).toBe(false);
  });

  it('accepts a plain label', () => {
    expect(checkGuards({ ...ok, label: 'not_found-2' }, {})).toEqual({ ok: true });
  });

  it('refuses without --i-am-a-human', () => {
    expect(checkGuards({ ...ok, iAmAHuman: false }, {})).toMatchObject({ ok: false });
  });

  it.each([undefined, '123', 'a'.repeat(44), '1'.repeat(45)])('refuses CDC %s', (cdc) => {
    expect(checkGuards({ ...ok, cdc }, {})).toMatchObject({ ok: false });
  });
});

describe('redaction', () => {
  it('keeps cookie names, drops values', () => {
    expect(redactCookieHeader('a=1; b=2')).toBe('a=<redacted>; b=<redacted>');
    expect(redactSetCookie('sid=secret; path=/; HttpOnly')).toBe(
      'sid=<redacted>; path=/; HttpOnly',
    );
  });

  it('replaces every secret form, even when URL-encoded', () => {
    const text = `${TOKEN} ${encodeURIComponent(TOKEN)} ${API_KEY}`;
    const out = redactSecrets(text, [
      { value: TOKEN, label: 'captcha-token' },
      { value: API_KEY, label: 'api-key' },
    ]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(encodeURIComponent(TOKEN));
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('<captcha-token>');
  });

  it('labels versions by quarter', () => {
    expect(versionLabel(new Date('2026-11-23T00:00:00Z'))).toBe('v2026-Q4');
    expect(versionLabel(new Date('2026-01-02T00:00:00Z'))).toBe('v2026-Q1');
  });
});

describe('runCapture', () => {
  const xml = '<rDE xmlns="x"><DE/></rDE>';

  function setup(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFake = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const target = url instanceof Request ? url.url : url.toString();
      calls.push({ url: target, init: init ?? {} });
      return Promise.resolve(handler(target, init ?? {}));
    }) as unknown as typeof fetch;
    const solver = { solveRecaptchaV2: vi.fn().mockResolvedValue(TOKEN) };
    return { calls, fetchFake, solver };
  }

  const okHandler = (url: string, init: RequestInit): Response => {
    if (init.method === 'POST') {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'sid=SESSIONVALUE; path=/; HttpOnly');
      headers.append('set-cookie', 'TS01=TSVALUE; Path=/');
      return new Response(`{"DE":{"echo":"${TOKEN}"}}`, { status: 200, headers });
    }
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
  };

  it('solves once, calls only the eKuatia host and records the request side redacted', async () => {
    const { calls, fetchFake, solver } = setup(okHandler);
    const result = await runCapture({
      cdc: CDC,
      fetch: fetchFake,
      solver,
      apiKey: API_KEY,
      skipCookieControl: false,
      now: () => new Date('2026-11-23T10:00:00Z'),
    });

    expect(solver.solveRecaptchaV2).toHaveBeenCalledTimes(1);
    expect(new Set(calls.map((c) => new URL(c.url).host))).toEqual(new Set([CAPTURE_HOSTS[0]]));
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET', 'GET']);
    // Real call carries the real token and cookies; the record does not.
    expect(calls[0]?.init.body).toEqual(expect.stringContaining(TOKEN));
    const [post, getPlain, getCookies] = result.records;
    expect(post.request.method).toBe('POST');
    expect(post.request.body).not.toContain(TOKEN);
    expect(post.request.body).toContain('<captcha-token>');
    expect(post.request.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(getPlain.request.cookie_names).toEqual([]);
    expect(getCookies.request.cookie_names).toEqual(['sid', 'TS01']);
    expect(getCookies.request.headers.cookie).toBe('sid=<redacted>; TS01=<redacted>');
    expect(JSON.stringify(result)).not.toMatch(/SESSIONVALUE|TSVALUE/);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(post.status_code).toBe(200);
    expect(result.documentXml).toBe(xml);
    expect(result.meta).toMatchObject({ cdc: CDC, version: 'v2026-Q4', cookie_control: true });
  });

  it('skips the cookie control GET on request', async () => {
    const { calls, fetchFake, solver } = setup(okHandler);
    await runCapture({
      cdc: CDC,
      fetch: fetchFake,
      solver,
      apiKey: API_KEY,
      skipCookieControl: true,
    });
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET']);
  });

  it('records a rejection (non-200) instead of throwing, and has no document', async () => {
    const { fetchFake, solver } = setup(() => new Response('{"error":"captcha"}', { status: 400 }));
    const result = await runCapture({
      cdc: CDC,
      fetch: fetchFake,
      solver,
      apiKey: API_KEY,
      skipCookieControl: false,
    });
    // A rejected POST stops the run: no GET is attempted after it.
    expect(result.records.map((r) => r.status_code)).toEqual([400]);
    expect(result.documentXml).toBeUndefined();
  });

  it('records a network failure as an error entry', async () => {
    const solver = { solveRecaptchaV2: vi.fn().mockResolvedValue(TOKEN) };
    const fetchFake = vi
      .fn()
      .mockRejectedValue(new Error(`boom ${TOKEN}`)) as unknown as typeof fetch;
    const result = await runCapture({
      cdc: CDC,
      fetch: fetchFake,
      solver,
      apiKey: API_KEY,
      skipCookieControl: true,
    });
    expect(result.records[0]?.error).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('probes a rejected captcha with an invalid token, without the solver or any spend', async () => {
    const { calls, fetchFake, solver } = setup(
      () => new Response('{"error":"captcha"}', { status: 400 }),
    );
    const result = await runCapture({
      cdc: CDC,
      fetch: fetchFake,
      solver,
      apiKey: API_KEY,
      skipCookieControl: false,
      probeRejectedCaptcha: true,
    });
    expect(solver.solveRecaptchaV2).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(result.meta).toMatchObject({ probe_rejected_captcha: true });
    expect(result.records[0]?.request.body).toContain('<captcha-token>');
  });
});

describe('isInsideVersionedTree', () => {
  it.each([
    ['/repo/apps/api/src', true],
    ['/repo/docs', true],
    ['/repo', true],
    ['/repo/apps/api/.captures', false],
    ['/repo/apps/api/.captures/x', false],
    ['/elsewhere/captures', false],
    ['/repository-other', false],
  ])('%s -> %s', (out, inside) => {
    expect(isInsideVersionedTree(out, '/repo')).toBe(inside);
  });
});
