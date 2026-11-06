// Creates the storage bucket with a SigV4-signed PUT (admin identity). Used by the CI job
// `storage-seaweedfs`; mirrors the `seaweedfs-init` compose service. Idempotent enough for CI:
// a bucket that already exists is treated as success.
import { pathToFileURL } from 'node:url';
import { signRequest } from './storage-smoke.mjs';

export async function createBucket(env = process.env) {
  const endpoint = env.STORAGE_ENDPOINT_URL ?? `http://127.0.0.1:${env.STORAGE_PORT ?? '9000'}`;
  const bucket = env.STORAGE_BUCKET ?? 'sifen-reception-dev';
  const region = env.STORAGE_REGION ?? 'us-east-1';
  const url = `${endpoint}/${bucket}`;
  const response = await fetch(url, {
    method: 'PUT',
    signal: AbortSignal.timeout(10_000),
    headers: signRequest({
      method: 'PUT',
      url,
      accessKey: env.STORAGE_ADMIN_ACCESS_KEY ?? 'dev-admin-access-key',
      secretKey: env.STORAGE_ADMIN_SECRET_KEY ?? 'dev-admin-secret-key-change-me',
      region,
      now: new Date(),
    }),
  });
  if (response.status !== 200 && response.status !== 409) {
    throw new Error(`bucket create returned ${response.status}, expected 200 or 409`);
  }
  return `bucket ${bucket} ready (${response.status})`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  createBucket().then(
    (message) => console.log(`storage-create-bucket: OK (${message})`),
    (error) => {
      console.error(`storage-create-bucket: FAIL: ${error.cause?.code ?? error.message}`);
      process.exit(1);
    },
  );
}
