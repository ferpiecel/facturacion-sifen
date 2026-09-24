import { hash, parseOptions } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { ARGON2_PARAMS, Argon2SecretVerifierAdapter } from './argon2-secret-verifier.adapter.js';

describe('Argon2SecretVerifierAdapter', () => {
  it('verifies a matching secret against its Argon2id hash', async () => {
    const secretHash = await hash('correct-secret');
    const verifier = new Argon2SecretVerifierAdapter();

    await expect(verifier.verify('correct-secret', secretHash)).resolves.toBe(true);
  });

  it('rejects a wrong secret', async () => {
    const secretHash = await hash('correct-secret');
    const verifier = new Argon2SecretVerifierAdapter();

    await expect(verifier.verify('wrong-secret', secretHash)).resolves.toBe(false);
  });

  it('rejects (never throws) for a malformed hash', async () => {
    const verifier = new Argon2SecretVerifierAdapter();

    await expect(verifier.verify('any-secret', 'not-a-valid-hash')).resolves.toBe(false);
  });

  it('hashes with ARGON2_PARAMS, verifiable against the same secret', async () => {
    const verifier = new Argon2SecretVerifierAdapter();

    const secretHash = await verifier.hash('a-new-secret');
    const parsed = parseOptions(secretHash);

    expect(parsed).toMatchObject(ARGON2_PARAMS);
    await expect(verifier.verify('a-new-secret', secretHash)).resolves.toBe(true);
  });
});
