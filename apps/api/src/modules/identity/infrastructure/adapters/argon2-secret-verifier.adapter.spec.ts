import { hash } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { Argon2SecretVerifierAdapter } from './argon2-secret-verifier.adapter.js';

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
});
