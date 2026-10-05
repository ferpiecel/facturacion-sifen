import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { TestPki } from './test-pki.ts';

export interface SeenRequest {
  readonly path: string;
  readonly method: string;
  readonly clientCn: string;
  readonly contentType: string | undefined;
  readonly body: string;
}

export interface MtlsServer {
  readonly baseUrl: string;
  readonly seen: SeenRequest[];
  /** Replaces the handler that answers every request (default: HTTP 200 `<ok/>`). */
  respondWith(handler: (res: ServerResponse, request: SeenRequest) => void): void;
  close(): Promise<void>;
}

/** Local HTTPS server that REQUIRES and verifies a client certificate signed by the test CA. */
export async function startMtlsServer(pki: TestPki): Promise<MtlsServer> {
  const seen: SeenRequest[] = [];
  let handler: (res: ServerResponse, request: SeenRequest) => void = (res) => {
    res.writeHead(200, { 'content-type': 'application/soap+xml' }).end('<ok/>');
  };
  const server: Server = createServer(
    {
      ...pki.server,
      ca: pki.caCert,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const peer = (req.socket as TLSSocket).getPeerCertificate();
        const request: SeenRequest = {
          path: req.url ?? '',
          method: req.method ?? '',
          clientCn: String(peer.subject.CN),
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        seen.push(request);
        handler(res, request);
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    seen,
    respondWith: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
