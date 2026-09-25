import { describe, expect, it } from 'vitest';
import { parseApiKey } from '../../domain/api-key.js';
import { IssueApiKeyUseCase } from '../../application/issue-api-key.use-case.js';
import { Argon2SecretVerifierAdapter } from './argon2-secret-verifier.adapter.js';
import { Argon2SecretHasherAdapter } from './argon2-secret-hasher.adapter.js';

describe('Argon2SecretHasherAdapter', () => {
  it('produces a hash the Argon2 verifier accepts for the same secret', async () => {
    const hasher = new Argon2SecretHasherAdapter();
    const verifier = new Argon2SecretVerifierAdapter();

    const hash = await hasher.hash('a-plausible-secret');

    await expect(verifier.verify('a-plausible-secret', hash)).resolves.toBe(true);
    await expect(verifier.verify('a-different-secret', hash)).resolves.toBe(false);
  });

  it('an api key issued through IssueApiKeyUseCase verifies with the real Argon2 verifier', async () => {
    const useCase = new IssueApiKeyUseCase(new Argon2SecretHasherAdapter());
    const verifier = new Argon2SecretVerifierAdapter();

    const issued = await useCase.execute('live');
    const parsed = parseApiKey(issued.formattedKey);
    const secret = parsed?.secret ?? '';

    await expect(verifier.verify(secret, issued.secretHash)).resolves.toBe(true);
    await expect(verifier.verify('wrong-secret', issued.secretHash)).resolves.toBe(false);
  });
});
