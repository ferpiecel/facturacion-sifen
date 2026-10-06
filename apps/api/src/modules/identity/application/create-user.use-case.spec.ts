import { parseOptions } from '@node-rs/argon2';
import { describe, expect, it, vi } from 'vitest';
import { ARGON2_PARAMS } from '../domain/argon2-params.js';
import { Argon2SecretHasherAdapter } from '../infrastructure/adapters/argon2-secret-hasher.adapter.js';
import { CreateUserUseCase, InvalidUserError } from './create-user.use-case.js';
import type { PasswordHasher } from './ports/password-hasher.port.js';

const PASSWORD = 'correct horse battery staple';

function setup() {
  const hash = vi.fn<PasswordHasher['hash']>().mockResolvedValue('$argon2id$stub');
  return { useCase: new CreateUserUseCase({ hash }), hash };
}

describe('CreateUserUseCase', () => {
  it('normalizes the email and hashes the password', async () => {
    const { useCase, hash } = setup();
    await expect(
      useCase.execute({ email: '  Ana.Perez@Example.COM ', displayName: ' Ana ', password: PASSWORD }),
    ).resolves.toEqual({
      email: 'ana.perez@example.com',
      displayName: 'Ana',
      passwordHash: '$argon2id$stub',
    });
    expect(hash).toHaveBeenCalledWith(PASSWORD);
  });

  it('rejects a weak password without hashing it, naming the issues', async () => {
    const { useCase, hash } = setup();
    const error = await useCase
      .execute({ email: 'ana@example.com', displayName: 'Ana', password: 'short' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidUserError);
    expect((error as InvalidUserError).issues).toEqual(['too_short']);
    expect(hash).not.toHaveBeenCalled();
  });

  it('applies the email as policy context', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({
        email: 'maria.gomez@example.com',
        displayName: 'Maria',
        password: 'maria.gomez2026!!',
      }),
    ).rejects.toMatchObject({ issues: ['context_specific'] });
  });

  it.each(['', 'no-at-sign', 'a@b', 'two@@example.com', 'sp ace@example.com'])(
    'rejects the invalid email %j',
    async (email) => {
      const { useCase } = setup();
      await expect(
        useCase.execute({ email, displayName: 'Ana', password: PASSWORD }),
      ).rejects.toMatchObject({ issues: ['invalid_email'] });
    },
  );

  it('rejects an email longer than the column allows', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({
        email: `${'a'.repeat(250)}@example.com`,
        displayName: 'Ana',
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ issues: ['invalid_email'] });
  });

  it('rejects a blank display name', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({ email: 'ana@example.com', displayName: '   ', password: PASSWORD }),
    ).rejects.toMatchObject({ issues: ['invalid_display_name'] });
  });

  it('the Argon2 adapter satisfies the port with the pinned parameters', async () => {
    const hashed = await new Argon2SecretHasherAdapter().hash(PASSWORD);
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(parseOptions(hashed)).toMatchObject(ARGON2_PARAMS);
  });
});
