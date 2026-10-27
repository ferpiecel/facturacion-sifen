import { afterEach, describe, expect, it } from 'vitest';
import { startMetricsServer } from './metrics-server.js';

/** Spec: HU-E14-01. The worker has no HTTP surface, so it serves Prometheus text on its own port. */
describe('startMetricsServer', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function start(token: string | undefined) {
    const server = await startMetricsServer({
      port: 0,
      token,
      handler: (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('sifen_up 1\n');
      },
    });
    closers.push(() => server.close());
    return `http://127.0.0.1:${String(server.address.port)}`;
  }

  it('serves /metrics with the bearer token and rejects a missing or wrong one', async () => {
    const base = await start('s3cret-token-value');
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    const ok = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer s3cret-token-value' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('sifen_up 1\n');
  });

  it('answers 404 for any other path, and serves without a token only when none is configured', async () => {
    const base = await start(undefined);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });
});
