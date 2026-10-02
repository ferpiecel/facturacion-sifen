import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { isBlockedAddress } from '../domain/blocked-address.js';
import type {
  WebhookErrorCode,
  WebhookHttpPort,
  WebhookHttpResult,
  WebhookRequest,
} from '../application/ports/webhook-http.port.js';

/** `isBlocked`, `request` and `ca` exist for tests only; production uses the SSRF policy and the system CAs. */
export interface SafeWebhookHttpOptions {
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  readonly isBlocked?: (address: string) => boolean;
  readonly request?: typeof httpsRequest;
  readonly ca?: string | Buffer;
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxBodyBytes?: number;
}

const systemResolve = async (hostname: string): Promise<readonly string[]> =>
  (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

const TLS_CODES =
  /^(ERR_TLS|ERR_SSL|ERR_OSSL|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH)/;
const CONNECT_CODES = /^(ECONN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE)/;

function classify(error: unknown): WebhookErrorCode {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (TLS_CODES.test(code)) return 'tls_failure';
  return CONNECT_CODES.test(code) ? 'connect_failed' : 'network_error';
}

const failure = (code: WebhookErrorCode): WebhookHttpResult => ({ kind: 'error', code });

/**
 * Outbound webhook transport with SSRF protection (HU-E11-01). Per attempt: https only, no userinfo;
 * resolve the host and refuse it unless EVERY address is public; connect to one of the vetted
 * addresses (the lookup is pinned, so DNS cannot answer differently between check and connect) while
 * Host and SNI keep the original hostname; never follow redirects; bound connect and total time;
 * read at most `maxBodyBytes` of the response and discard it (only the status matters).
 */
export class SafeWebhookHttp implements WebhookHttpPort {
  private readonly resolve: (hostname: string) => Promise<readonly string[]>;
  private readonly isBlocked: (address: string) => boolean;
  private readonly requestFn: typeof httpsRequest;
  private readonly limits: { connect: number; total: number; body: number };

  constructor(private readonly options: SafeWebhookHttpOptions = {}) {
    this.resolve = options.resolve ?? systemResolve;
    this.isBlocked = options.isBlocked ?? isBlockedAddress;
    this.requestFn = options.request ?? httpsRequest;
    this.limits = {
      connect: options.connectTimeoutMs ?? 5_000,
      total: options.totalTimeoutMs ?? 10_000,
      body: options.maxBodyBytes ?? 64 * 1024,
    };
  }

  async post(request: WebhookRequest): Promise<WebhookHttpResult> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return failure('invalid_url');
    }
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hostname === ''
    ) {
      return failure('invalid_url');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly string[] = [host];
    if (isIP(host) === 0) {
      try {
        addresses = await this.resolve(host);
      } catch {
        return failure('dns_failure');
      }
    }
    if (addresses.length === 0) return failure('dns_failure');
    if (addresses.some((address) => this.isBlocked(address))) return failure('blocked_address');
    return this.send(url, host, addresses[0], request);
  }

  private send(
    url: URL,
    host: string,
    address: string,
    request: WebhookRequest,
  ): Promise<WebhookHttpResult> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: WebhookHttpResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        resolve(result);
      };
      const family = isIP(address);
      const options: RequestOptions = {
        method: 'POST',
        host,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: {
          ...request.headers,
          host: url.host,
          'content-length': Buffer.byteLength(request.body),
        },
        agent: false,
        ca: this.options.ca,
        servername: isIP(host) === 0 ? host : undefined,
        // Pinned: the vetted address is the only one this connection can use.
        lookup: ((
          _hostname: string,
          lookupOptions: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (lookupOptions.all === true) {
            callback(null, [{ address, family }]);
          } else {
            callback(null, address, family);
          }
        }) as RequestOptions['lookup'],
      };
      let connectTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      try {
        const outgoing = this.requestFn(options, (response) => {
          done({ kind: 'response', status: response.statusCode ?? 0 });
          let read = 0;
          response.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > this.limits.body) response.destroy();
          });
          response.on('error', () => undefined);
        });
        const timeout = (): void => {
          outgoing.destroy();
          done(failure('timeout'));
        };
        connectTimer = setTimeout(timeout, this.limits.connect);
        totalTimer = setTimeout(timeout, this.limits.total);
        outgoing.on('socket', (socket) => {
          socket.once('secureConnect', () => {
            clearTimeout(connectTimer);
          });
        });
        outgoing.on('error', (error) => {
          done(failure(classify(error)));
        });
        outgoing.on('close', () => {
          clearTimeout(totalTimer);
          done(failure('network_error'));
        });
        outgoing.end(request.body);
      } catch {
        clearTimeout(totalTimer);
        done(failure('network_error'));
      }
    });
  }
}
