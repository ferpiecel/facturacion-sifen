import { describe, expect, it } from 'vitest';
import { createHttpAdapter } from '../../../../bootstrap/http.js';

describe('createHttpAdapter client IP (never a raw X-Forwarded-For)', () => {
  async function ipSeenBy(hops: number, headers: Record<string, string>) {
    const adapter = createHttpAdapter(hops);
    const fastify = adapter.getInstance();
    fastify.get('/ip', (request) => ({ ip: request.ip }));
    await fastify.ready();
    const res = await fastify.inject({
      method: 'GET',
      url: '/ip',
      headers,
      remoteAddress: '198.51.100.7',
    });
    await fastify.close();
    return res.json<{ ip: string }>().ip;
  }

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    expect(await ipSeenBy(0, { 'x-forwarded-for': '203.0.113.9' })).toBe('198.51.100.7');
  });

  it('with one trusted hop takes the address that hop added, not what the client prepended', async () => {
    expect(await ipSeenBy(1, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })).toBe('203.0.113.9');
  });
});
