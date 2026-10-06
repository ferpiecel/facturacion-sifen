import { describe, expect, it } from 'vitest';
import { CreateUserUseCase } from '../../application/create-user.use-case.js';
import { VerifyPasswordUseCase } from '../../application/verify-password.use-case.js';
import { Argon2SecretHasherAdapter } from './argon2-secret-hasher.adapter.js';
import { Argon2SecretVerifierAdapter } from './argon2-secret-verifier.adapter.js';

/** A password created in one Unicode form must log in from another (NIST SP 800-63B: normalize). */
describe('portal password create then verify with the real Argon2 adapters', () => {
  const NFC = 'café au lait es muy rico';
  const NFD = 'café au lait es muy rico';
  const COMPAT = 'café au lait es muy rico'.replace('au', 'ﬁu');

  async function login(created: string, attempt: string) {
    const user = await new CreateUserUseCase(new Argon2SecretHasherAdapter()).execute({
      email: 'ana@example.com',
      displayName: 'Ana',
      password: created,
    });
    const lookup = {
      findByEmail: () =>
        Promise.resolve({ userId: 'user-1', passwordHash: user.passwordHash, disabled: false }),
    };
    return new VerifyPasswordUseCase(lookup, new Argon2SecretVerifierAdapter()).execute(
      'ana@example.com',
      attempt,
    );
  }

  it('created as NFC, verified as NFD', async () => {
    await expect(login(NFC, NFD)).resolves.toEqual({ userId: 'user-1' });
  });

  it('created as NFD, verified as NFC', async () => {
    await expect(login(NFD, NFC)).resolves.toEqual({ userId: 'user-1' });
  });

  it('a compatibility form (ligature) matches its plain spelling', async () => {
    const plain = 'café first thing in the morning';
    await expect(login(plain, plain.replace('fi', 'ﬁ'))).resolves.toEqual({ userId: 'user-1' });
  });

  it('a different password is still refused', async () => {
    await expect(login(NFC, `${NFC}!`)).resolves.toBeNull();
  });
});
