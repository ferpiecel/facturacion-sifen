import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SifenProtocolError, SifenTimeoutError, SifenTransportError } from '../errors.ts';
import { createTestPki, type TestPki } from '../../test/support/test-pki.ts';
import { createHttpsSoapTransport } from './transport.ts';

let pki: TestPki;
let server: Server;
let seen: {
  clientCn: string;
  protocol: string | null;
  contentType?: string;
  body: string;
}[];
let respond: (res: import('node:http').ServerResponse) => void;

beforeAll(() => {
  pki = createTestPki();
});

async function start(requestCert = true): Promise<string> {
  seen = [];
  respond = (res) => res.writeHead(200, { 'content-type': 'application/soap+xml' }).end('<ok/>');
  server = createServer(
    {
      ...pki.server,
      ca: pki.caCert,
      requestCert,
      rejectUnauthorized: requestCert,
      minVersion: 'TLSv1.2',
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
        seen.push({
          clientCn: String(peer.subject.CN),
          protocol: (req.socket as import('node:tls').TLSSocket).getProtocol(),
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString(),
        });
        respond(res);
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `https://127.0.0.1:${String((server.address() as AddressInfo).port)}/de/ws/x`;
}

afterEach(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    }),
);
afterAll(() => undefined);

const transportFor = (overrides: Partial<Parameters<typeof createHttpsSoapTransport>[0]> = {}) =>
  createHttpsSoapTransport({
    credentials: { load: () => Promise.resolve({ ...pki.client, ca: pki.caCert }) },
    ...overrides,
  });

describe('createHttpsSoapTransport', () => {
  it('posts the SOAP 1.2 body, presents the tenant client certificate over TLS >= 1.2 and returns status and body', async () => {
    const url = await start();

    const response = await transportFor().post({ operation: 'enviarLote', url, body: '<soap/>' });

    expect(response).toEqual({ status: 200, body: '<ok/>' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ clientCn: 'tenant-client', body: '<soap/>' });
    expect(seen[0]?.contentType).toContain('application/soap+xml');
    expect(['TLSv1.2', 'TLSv1.3']).toContain(seen[0]?.protocol);
  });

  it('returns non-2xx responses so SOAP Faults (HTTP 500) can be interpreted', async () => {
    const url = await start();
    respond = (res) => res.writeHead(500).end('<fault/>');

    await expect(
      transportFor().post({ operation: 'consultarLote', url, body: 'x' }),
    ).resolves.toEqual({
      status: 500,
      body: '<fault/>',
    });
  });

  it('verifies the server certificate: a server signed by an unknown CA is a transport error', async () => {
    const url = await start();
    const transport = createHttpsSoapTransport({
      credentials: { load: () => Promise.resolve({ ...pki.client, ca: pki.otherCaCert }) },
    });

    const error = await transport
      .post({ operation: 'enviarLote', url, body: 'x' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SifenTransportError);
    expect(seen).toHaveLength(0);
  });

  it('fails when no client certificate is presented to a server requiring one', async () => {
    const url = await start();
    const transport = createHttpsSoapTransport({
      credentials: { load: () => Promise.resolve({ key: '', cert: '', ca: pki.caCert }) },
    });

    await expect(
      transport.post({ operation: 'enviarLote', url, body: 'x' }),
    ).rejects.toBeInstanceOf(SifenTransportError);
  });

  it('maps a server that never answers to SifenTimeoutError', async () => {
    const url = await start();
    respond = () => undefined;

    const error = await transportFor({ timeoutMs: 150 })
      .post({ operation: 'consultarRUC', url, body: 'x' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SifenTimeoutError);
    expect(error).toMatchObject({ operation: 'consultarRUC' });
  });

  it('maps a refused connection to SifenTransportError', async () => {
    const url = await start();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );

    await expect(
      transportFor().post({ operation: 'enviarLote', url, body: 'x' }),
    ).rejects.toBeInstanceOf(SifenTransportError);
    server = createServer(() => undefined); // keep afterEach symmetrical
  });

  it('aborts a response above the size cap with SifenProtocolError', async () => {
    const url = await start();
    respond = (res) => res.writeHead(200).end('a'.repeat(5000));

    await expect(
      transportFor({ maxResponseBytes: 1024 }).post({ operation: 'enviarLote', url, body: 'x' }),
    ).rejects.toBeInstanceOf(SifenProtocolError);
  });

  it('surfaces a credential loading failure as SifenTransportError without sending anything', async () => {
    const url = await start();
    const transport = createHttpsSoapTransport({
      credentials: { load: () => Promise.reject(new Error('vault')) },
    });

    await expect(
      transport.post({ operation: 'enviarLote', url, body: 'x' }),
    ).rejects.toBeInstanceOf(SifenTransportError);
    expect(seen).toHaveLength(0);
  });
});
