import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SifenFaultError, SifenTimeoutError, SifenTransportError } from '../errors.ts';
import {
  fault12Xml,
  loteConcluidoXml,
  loteRecibidoXml,
} from '../../test/fixtures/soap/responses.ts';
import { startMtlsServer, type MtlsServer } from '../../test/support/mtls-server.ts';
import { createTestPki, type TestPki } from '../../test/support/test-pki.ts';
import { sifenEndpoints } from './endpoints.ts';
import { SoapSifenGateway } from './soap-sifen-gateway.ts';
import { createHttpsSoapTransport } from './transport.ts';

const DE = '<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd"><DE Id="1">uno</DE></rDE>';

let pki: TestPki;
let server: MtlsServer | undefined;

beforeAll(() => {
  pki = createTestPki();
});
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function gateway(
  timeoutMs = 5000,
): Promise<{ gateway: SoapSifenGateway; server: MtlsServer }> {
  server = await startMtlsServer(pki);
  const transport = createHttpsSoapTransport({
    timeoutMs,
    credentials: { load: () => Promise.resolve({ ...pki.client, ca: pki.caCert }) },
  });
  const endpoints = sifenEndpoints('test', {
    enviarLote: `${server.baseUrl}/de/ws/async/recibe-lote`,
    consultarLote: `${server.baseUrl}/de/ws/consultas/consulta-lote`,
  });
  return { gateway: new SoapSifenGateway({ transport, endpoints }), server };
}

describe('SoapSifenGateway.enviarLote', () => {
  it('posts the zipped lote envelope with the tenant certificate and parses the receipt', async () => {
    const ctx = await gateway();
    ctx.server.respondWith((res) => res.writeHead(200).end(loteRecibidoXml));

    const receipt = await ctx.gateway.enviarLote({ dId: 42n, des: [DE] });

    expect(receipt).toEqual({
      dCodRes: '0300',
      dMsgRes: 'Lote recibido con éxito',
      dProtConsLote: '47353',
    });
    const [request] = ctx.server.seen;
    expect(request).toMatchObject({
      method: 'POST',
      path: '/de/ws/async/recibe-lote',
      clientCn: 'tenant-client',
    });
    expect(request.contentType).toContain('application/soap+xml');
    expect(request.body).toContain('<dId>42</dId>');
    const xDE = /<xDE>([^<]+)<\/xDE>/.exec(request.body)?.[1] ?? '';
    const zip = Buffer.from(xDE, 'base64');
    const dataStart = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
    const inflated = inflateRawSync(zip.subarray(dataStart, dataStart + zip.readUInt32LE(18)));
    expect(inflated.toString()).toContain('<rLoteDE>');
    expect(inflated.toString()).toContain('Id="1"');
  });

  it('never retries: a timeout is one request and a SifenTimeoutError', async () => {
    const ctx = await gateway(150);
    ctx.server.respondWith(() => undefined);

    await expect(ctx.gateway.enviarLote({ dId: 1n, des: [DE] })).rejects.toBeInstanceOf(
      SifenTimeoutError,
    );
    expect(ctx.server.seen).toHaveLength(1);
  });

  it('maps a SOAP Fault answered with HTTP 500 to SifenFaultError', async () => {
    const ctx = await gateway();
    ctx.server.respondWith((res) => res.writeHead(500).end(fault12Xml));

    await expect(ctx.gateway.enviarLote({ dId: 1n, des: [DE] })).rejects.toBeInstanceOf(
      SifenFaultError,
    );
  });

  it('maps a non-SOAP HTTP error page to SifenTransportError', async () => {
    const ctx = await gateway();
    ctx.server.respondWith((res) => res.writeHead(502).end('<html>Bad Gateway</html>'));

    await expect(ctx.gateway.enviarLote({ dId: 1n, des: [DE] })).rejects.toBeInstanceOf(
      SifenTransportError,
    );
  });

  it('rejects an empty lote before sending anything', async () => {
    const ctx = await gateway();

    await expect(ctx.gateway.enviarLote({ dId: 1n, des: [] })).rejects.toBeInstanceOf(RangeError);
    expect(ctx.server.seen).toHaveLength(0);
  });
});

describe('SoapSifenGateway.consultarLote', () => {
  it('posts rEnviConsLoteDe and parses the per-DE results', async () => {
    const ctx = await gateway();
    ctx.server.respondWith((res) => res.writeHead(200).end(loteConcluidoXml));

    const result = await ctx.gateway.consultarLote({ dId: 7n, dProtConsLote: '47353' });

    expect(result.dCodRes).toBe('0362');
    expect(result.resultados).toHaveLength(2);
    const [request] = ctx.server.seen;
    expect(request.path).toBe('/de/ws/consultas/consulta-lote');
    expect(request.body).toContain(
      '<rEnviConsLoteDe xmlns="http://ekuatia.set.gov.py/sifen/xsd"><dId>7</dId><dProtConsLote>47353</dProtConsLote></rEnviConsLoteDe>',
    );
  });

  it('refuses a protocol number that is not 1-15 digits (no markup injection)', async () => {
    const ctx = await gateway();

    await expect(
      ctx.gateway.consultarLote({ dId: 7n, dProtConsLote: '1</dProtConsLote><x/>' }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(ctx.server.seen).toHaveLength(0);
  });
});
