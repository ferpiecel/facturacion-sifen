import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSmoke, signRequest } from './storage-smoke.mjs';

test('signRequest is deterministic and scopes the credential', () => {
  const input = {
    method: 'PUT',
    url: 'http://127.0.0.1:9000/bucket/key.txt',
    body: 'abc',
    accessKey: 'AKID',
    secretKey: 'SECRET',
    region: 'us-east-1',
    now: new Date('2026-01-02T03:04:05.678Z'),
  };
  const first = signRequest(input);
  assert.deepEqual(signRequest(input), first);
  assert.equal(first['x-amz-date'], '20260102T030405Z');
  assert.match(
    first.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKID\/20260102\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  assert.notEqual(signRequest({ ...input, secretKey: 'OTHER' }).authorization, first.authorization);
});

test('runSmoke rejects when the endpoint is unreachable', async () => {
  await assert.rejects(runSmoke({ STORAGE_ENDPOINT_URL: 'http://127.0.0.1:1' }));
});
