import { request } from 'node:https';
import { SifenProtocolError, SifenTimeoutError, SifenTransportError } from '../errors.ts';
import type { SifenOperation } from '../port.ts';

/** Tenant TLS client credentials (PEM), e.g. derived from the tenant's .p12 by the custody layer. */
export interface MtlsCredential {
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  /** Trust anchors (e.g. the DNIT CA bundle). When set they REPLACE the default roots. */
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
}

/** Port: how the adapter obtains credentials, so it never touches the certificate vault itself. */
export interface MtlsCredentialSource {
  load(): Promise<MtlsCredential>;
}

export interface SoapRequest {
  readonly operation: SifenOperation;
  readonly url: string;
  readonly body: string;
}

export interface SoapResponse {
  readonly status: number;
  readonly body: string;
}

export interface SoapTransport {
  post(request: SoapRequest): Promise<SoapResponse>;
}

export interface HttpsTransportOptions {
  readonly credentials: MtlsCredentialSource;
  /** Whole-call deadline (connect + request + response). Default 30 s. */
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Mutual-TLS SOAP 1.2 transport (MT v150 §7.4: TLS 1.2 with mutual authentication). The server
 * certificate is always verified, there is no switch to disable it. One fresh connection per call
 * (`agent: false`) so a tenant's session or credentials are never reused for another one.
 * It never retries (ADR-0007): callers decide what an unknown outcome means.
 * @throws SifenTimeoutError past the deadline, SifenProtocolError past the size cap, SifenTransportError otherwise
 */
export function createHttpsSoapTransport(options: HttpsTransportOptions): SoapTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  async function post({ operation, url, body }: SoapRequest): Promise<SoapResponse> {
    let credential: MtlsCredential;
    try {
      credential = await options.credentials.load();
    } catch (cause) {
      throw new SifenTransportError(operation, { cause });
    }

    return new Promise<SoapResponse>((resolve, reject) => {
      const payload = Buffer.from(body, 'utf8');
      const req = request(
        url,
        {
          method: 'POST',
          agent: false,
          key: credential.key,
          cert: credential.cert,
          ...(credential.ca === undefined ? {} : { ca: credential.ca as string | Buffer }),
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
          headers: {
            'content-type': 'application/soap+xml; charset=utf-8',
            'content-length': payload.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              fail(new SifenProtocolError(operation, `response exceeds ${String(maxBytes)} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            settle(() => {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          });
          res.on('error', (cause) => {
            fail(new SifenTransportError(operation, { cause }));
          });
        },
      );

      let done = false;
      const timer = setTimeout(() => {
        fail(new SifenTimeoutError(operation));
      }, timeoutMs);
      function settle(action: () => void): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        action();
      }
      function fail(error: Error): void {
        settle(() => {
          req.destroy();
          reject(error);
        });
      }
      req.on('error', (cause) => {
        fail(new SifenTransportError(operation, { cause }));
      });
      req.end(payload);
    });
  }

  return { post };
}
