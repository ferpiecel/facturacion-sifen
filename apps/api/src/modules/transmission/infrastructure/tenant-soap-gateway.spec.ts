import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { SifenCircuitOpenError, SifenFaultError, type SifenGateway } from '@sifen/sifen-gateway';
import { createTestAuthority, issueTestPkcs12 } from '../../../../test/support/test-pki.js';
import { pkcs12ToMtlsCredential } from '../../certificates/infrastructure/pkcs12-mtls-credential.js';
import { TenantSoapGatewayFactory } from './tenant-soap-gateway.js';

const FAULT =
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>' +
  '<env:Code><env:Value>env:Receiver</env:Value></env:Code>' +
  '<env:Reason><env:Text xml:lang="en">boom</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>';

const root = createTestAuthority('Test Root');
const tenantCert = issueTestPkcs12(root);
const serverCert = pkcs12ToMtlsCredential(
  issueTestPkcs12(root, { omitExtendedKeyUsage: true, san: [{ type: 'dns', value: 'localhost' }] })
    .p12,
  'test-p12-password',
);

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function stub(): Promise<{ url: string; clientCns: string[] }> {
  const clientCns: string[] = [];
  server = createServer(
    {
      key: serverCert.key,
      cert: serverCert.cert,
      ca: root.pem,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      clientCns.push(String((req.socket as TLSSocket).getPeerCertificate().subject.CN));
      req.resume();
      res.writeHead(200, { 'content-type': 'application/soap+xml' }).end(FAULT);
    },
  );
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return {
    url: `https://localhost:${String((server.address() as AddressInfo).port)}/x`,
    clientCns,
  };
}

const request = { dId: 1n, ruc: '80000000' };
const now = () => new Date('2026-10-27T12:00:00Z');

function build(overrides: Partial<ConstructorParameters<typeof TenantSoapGatewayFactory>[0]> = {}) {
  const opened: string[] = [];
  const factory = new TenantSoapGatewayFactory({
    environments: { environmentOf: () => Promise.resolve('test' as const) },
    certificates: {
      open: (tenantId, environment) => {
        opened.push(`${tenantId}:${environment}`);
        return Promise.resolve({ p12: Buffer.from(tenantCert.p12), password: tenantCert.password });
      },
    },
    allowProduction: false,
    retryAfterMs: 60_000,
    now,
    ...overrides,
  });
  return { factory, opened };
}

describe('TenantSoapGatewayFactory', () => {
  it('calls SIFEN over mTLS with the tenant certificate', async () => {
    const { url, clientCns } = await stub();
    const { factory, opened } = build({
      trustedRoots: root.pem,
      endpointOverrides: { consultarRUC: url },
      allowCustomHost: true,
    });
    await expect(factory.forTenant('t-1').consultarRUC(request)).rejects.toBeInstanceOf(
      SifenFaultError,
    );
    expect(clientCns).toEqual(['Tenant S.A.']);
    expect(opened).toEqual(['t-1:test']);
  });

  it('defers (nothing sent) when the tenant has no usable certificate', async () => {
    const { factory } = build({
      certificates: { open: () => Promise.reject(new Error('no active certificate')) },
    });
    const error = await factory
      .forTenant('t-1')
      .consultarRUC(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SifenCircuitOpenError);
    expect((error as SifenCircuitOpenError).retryAt).toEqual(new Date(now().getTime() + 60_000));
  });

  it('refuses a production tenant unless production is allowed, without touching the certificate', async () => {
    const { factory, opened } = build({
      environments: { environmentOf: () => Promise.resolve('production' as const) },
    });
    await expect(factory.forTenant('t-1').consultarRUC(request)).rejects.toBeInstanceOf(
      SifenCircuitOpenError,
    );
    expect(opened).toEqual([]);
  });

  it('is a SifenGateway for every operation', () => {
    const gateway: SifenGateway = build().factory.forTenant('t-1');
    expect(Object.keys(gateway).sort()).toEqual(
      [
        'consultarDE',
        'consultarLote',
        'consultarRUC',
        'enviarDESincronico',
        'enviarEventos',
        'enviarLote',
      ].sort(),
    );
  });
});
