import { describe, expect, it, vi } from 'vitest';
import { DUMMY_HASH } from './authenticate-api-key.use-case.js';
import type { SecretVerifier } from './ports/secret-verifier.port.js';
import type { UserCredential, UserCredentialLookup } from './ports/user-credential-lookup.port.js';
import { VerifyPasswordUseCase } from './verify-password.use-case.js';

const USER: UserCredential = { userId: 'user-1', passwordHash: 'real-hash', disabled: false };

function setup(user: UserCredential | null, valid: boolean) {
  const findByEmail = vi.fn<UserCredentialLookup['findByEmail']>().mockResolvedValue(user);
  const verify = vi.fn<SecretVerifier['verify']>().mockResolvedValue(valid);
  const useCase = new VerifyPasswordUseCase({ findByEmail }, { verify });
  return { useCase, findByEmail, verify };
}

describe('VerifyPasswordUseCase', () => {
  it('returns the user id for a correct password', async () => {
    const { useCase, verify } = setup(USER, true);
    await expect(useCase.execute('Ana@Example.com ', 'pw')).resolves.toEqual({ userId: 'user-1' });
    expect(verify).toHaveBeenCalledWith('pw', 'real-hash');
  });

  it('looks the user up by the normalized email', async () => {
    const { useCase, findByEmail } = setup(USER, true);
    await useCase.execute('  Ana@Example.com ', 'pw');
    expect(findByEmail).toHaveBeenCalledWith('ana@example.com');
  });

  it('returns null for a wrong password', async () => {
    const { useCase } = setup(USER, false);
    await expect(useCase.execute('ana@example.com', 'bad')).resolves.toBeNull();
  });

  it('verifies against the dummy hash for an unknown email, so timing does not reveal it', async () => {
    const { useCase, verify } = setup(null, false);
    await expect(useCase.execute('nobody@example.com', 'pw')).resolves.toBeNull();
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith('pw', DUMMY_HASH);
  });

  it('still spends one verification on a malformed email and never queries the lookup', async () => {
    const { useCase, verify, findByEmail } = setup(USER, true);
    await expect(useCase.execute('not-an-email', 'pw')).resolves.toBeNull();
    expect(findByEmail).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith('pw', DUMMY_HASH);
  });

  it('returns null for a disabled user even with the right password, after verifying', async () => {
    const { useCase, verify } = setup({ ...USER, disabled: true }, true);
    await expect(useCase.execute('ana@example.com', 'pw')).resolves.toBeNull();
    expect(verify).toHaveBeenCalledOnce();
  });
});
