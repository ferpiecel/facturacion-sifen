import { describe, expect, it } from 'vitest';
import { validateEndpointEvents, validateEndpointUrl } from './webhook-endpoint-input.js';

describe('webhook endpoint input (HU-E11-01 API)', () => {
  it.each([
    'https://hooks.example.com/sifen',
    'https://hooks.example.com:8443/a?b=1#c',
    'https://8.8.8.8/x',
    'https://[2606:4700:4700::1111]/x',
  ])('accepts the url %s', (url) => {
    expect(validateEndpointUrl(url)).toEqual({ ok: true, value: url });
  });

  it.each([
    ['', 'empty'],
    ['http://hooks.example.com/x', 'plain http'],
    ['HTTPS://hooks.example.com/x', 'uppercase scheme'],
    ['https://user:pw@hooks.example.com/', 'userinfo'],
    ['https:///x', 'empty host'],
    ['https://:443/x', 'empty host with a port'],
    ['https://exa mple.com/', 'whitespace'],
    ['https://hooks.example.com:70000/', 'port out of range'],
    [`https://hooks.example.com/${'a'.repeat(2048)}`, 'too long'],
    ['https://127.0.0.1/x', 'loopback literal'],
    ['https://10.1.2.3/x', 'private literal'],
    ['https://169.254.169.254/latest', 'metadata literal'],
    ['https://[::1]/x', 'IPv6 loopback literal'],
    ['https://[fd00::1]/x', 'IPv6 unique-local literal'],
    ['https://localhost/x', 'localhost'],
    ['https://api.localhost/x', 'localhost subdomain'],
  ])('rejects the url %j (%s)', (url) => {
    const result = validateEndpointUrl(url);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-string url', () => {
    expect(validateEndpointUrl(42)).toMatchObject({ ok: false });
    expect(validateEndpointUrl(undefined)).toMatchObject({ ok: false });
  });

  it('accepts known events, an empty list (all events) and nothing else', () => {
    expect(validateEndpointEvents(['document.approved', 'document.rejected'])).toEqual({
      ok: true,
      value: ['document.approved', 'document.rejected'],
    });
    expect(validateEndpointEvents([])).toEqual({ ok: true, value: [] });
    for (const bad of [
      ['document.nope'],
      ['document.approved', 'document.approved'],
      'document.approved',
      [1],
      null,
      undefined,
    ]) {
      expect(validateEndpointEvents(bad)).toMatchObject({ ok: false });
    }
  });
});
