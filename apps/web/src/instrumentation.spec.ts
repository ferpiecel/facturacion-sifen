import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { register } from './instrumentation';

describe('instrumentation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins the client address on the Node HTTP server of the portal', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register();
    const server = http.createServer((req, res) => {
      res.end(String(req.headers['x-forwarded-for']));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${String(port)}`, {
      headers: { 'x-forwarded-for': '6.6.6.6' },
    });
    expect(await response.text()).toBe('127.0.0.1');
    server.close();
  });

  it('does nothing outside the Node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await expect(register()).resolves.toBeUndefined();
  });
});
