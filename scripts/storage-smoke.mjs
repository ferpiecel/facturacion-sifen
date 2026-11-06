// Smoke test for the local SeaweedFS S3 endpoint (docker compose service `seaweedfs`).
// Asserts that an anonymous PUT is refused and that a SigV4-signed PUT/GET succeeds.
// Self-contained SigV4 signer: host curl --aws-sigv4 is unreliable before 7.84.
// Local development only: defaults match the non-secret compose credentials.
import { createHash, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** Returns the headers (Authorization etc.) of a SigV4-signed S3 request. */
export function signRequest({ method, url, body = '', accessKey, secretKey, region, now }) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = {
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    method,
    target.pathname,
    target.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function runSmoke(env = process.env) {
  const endpoint = env.STORAGE_ENDPOINT_URL ?? `http://127.0.0.1:${env.STORAGE_PORT ?? '9000'}`;
  const bucket = env.STORAGE_BUCKET ?? 'sifen-reception-dev';
  const region = env.STORAGE_REGION ?? 'us-east-1';
  const accessKey = env.STORAGE_APP_ACCESS_KEY ?? 'dev-app-access-key';
  const secretKey = env.STORAGE_APP_SECRET_KEY ?? 'dev-app-secret-key-change-me';
  const url = `${endpoint}/${bucket}/smoke/${Date.now()}-${process.pid}.txt`;
  const body = 'storage-smoke';
  const signed = (method, payload = '') =>
    fetch(url, {
      method,
      body: payload === '' ? undefined : payload,
      signal: AbortSignal.timeout(10_000),
      headers: signRequest({
        method,
        url,
        body: payload,
        accessKey,
        secretKey,
        region,
        now: new Date(),
      }),
    });

  const anonymous = await fetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(10_000) });
  if (anonymous.status !== 401 && anonymous.status !== 403) {
    throw new Error(`anonymous PUT returned ${anonymous.status}, expected 401 or 403`);
  }
  const put = await signed('PUT', body);
  if (put.status !== 200) throw new Error(`signed PUT returned ${put.status}, expected 200`);
  const got = await signed('GET');
  if (got.status !== 200 || (await got.text()) !== body) throw new Error('signed GET mismatch');
  await signed('DELETE').catch(() => undefined);
  return `anonymous PUT refused with ${anonymous.status}, signed PUT/GET succeeded`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSmoke().then(
    (message) => console.log(`storage-smoke: OK (${message})`),
    (error) => {
      console.error(`storage-smoke: FAIL: ${error.cause?.code ?? error.message}`);
      process.exit(1);
    },
  );
}
