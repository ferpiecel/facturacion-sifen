import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MetricsServerOptions {
  readonly port: number;
  /** Interface to bind; loopback by default so the listener is not exposed unless configured. */
  readonly host?: string;
  /** Bearer token; without one the endpoint is open (only allowed outside production by the config). */
  readonly token: string | undefined;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Serves `GET /metrics` for the worker process (HU-E14-01); anything else is a 404. */
export async function startMetricsServer(
  options: MetricsServerOptions,
): Promise<{ readonly address: AddressInfo; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url?.split('?')[0] !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    if (options.token) {
      const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
      if (!timingSafeEqual(digest(given), digest(options.token))) {
        response.writeHead(401).end();
        return;
      }
    }
    options.handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', resolve);
  });
  return {
    address: server.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
