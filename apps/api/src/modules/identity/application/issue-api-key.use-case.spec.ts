import { describe, expect, it, vi } from 'vitest';
import { parseApiKey } from '../domain/api-key.js';
import type { SecretHasher } from './ports/secret-hasher.port.js';
import { IssueApiKeyUseCase } from './issue-api-key.use-case.js';

describe('IssueApiKeyUseCase', () => {
  it('formats a key that parseApiKey accepts, hashing the generated secret', async () => {
    const hash = vi.fn<SecretHasher['hash']>().mockResolvedValue('hashed-secret');
    const useCase = new IssueApiKeyUseCase({ hash });

    const issued = await useCase.execute('live');

    const parsed = parseApiKey(issued.formattedKey);
    expect(parsed).toEqual({
      environment: 'live',
      keyId: issued.keyId,
      secret: expect.any(String) as string,
    });
    expect(hash).toHaveBeenCalledWith(parsed?.secret);
    expect(issued.secretHash).toBe('hashed-secret');
  });

  it('two issuances never share a keyId or a secret', async () => {
    const useCase = new IssueApiKeyUseCase({ hash: () => Promise.resolve('h') });

    const first = await useCase.execute('live');
    const second = await useCase.execute('live');

    expect(first.keyId).not.toBe(second.keyId);
    expect(parseApiKey(first.formattedKey)?.secret).not.toBe(
      parseApiKey(second.formattedKey)?.secret,
    );
  });
});
