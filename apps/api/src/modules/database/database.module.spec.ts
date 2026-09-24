import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE, DATABASE_HANDLE, DatabaseModule } from './database.module.js';

const assertNonPrivilegedSession = vi.fn<(db: unknown) => Promise<void>>();
const createNodePostgresDatabase = vi.fn<(url: string) => unknown>();

vi.mock('@sifen/db', () => ({
  assertNonPrivilegedSession: (db: unknown) => assertNonPrivilegedSession(db),
  createNodePostgresDatabase: (url: string) => createNodePostgresDatabase(url),
}));

describe('DatabaseModule', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it('provides a null DATABASE_HANDLE and DATABASE when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();

    expect(moduleRef.get(DATABASE_HANDLE)).toBeNull();
    expect(moduleRef.get(DATABASE)).toBeNull();
    expect(createNodePostgresDatabase).not.toHaveBeenCalled();
  });

  it('creates a handle and asserts a non-privileged session when DATABASE_URL is set', async () => {
    process.env.DATABASE_URL = 'postgres://app_login:pw@localhost:5432/sifen';
    const fakeDb = { marker: 'db' };
    const fakeHandle = { db: fakeDb, migrate: vi.fn(), close: vi.fn() };
    createNodePostgresDatabase.mockReturnValue(fakeHandle);
    assertNonPrivilegedSession.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();

    expect(createNodePostgresDatabase).toHaveBeenCalledWith(process.env.DATABASE_URL);
    expect(assertNonPrivilegedSession).toHaveBeenCalledWith(fakeDb);
    expect(moduleRef.get(DATABASE_HANDLE)).toBe(fakeHandle);
    expect(moduleRef.get(DATABASE)).toBe(fakeDb);
  });

  it('propagates a privileged-session rejection instead of silently booting', async () => {
    process.env.DATABASE_URL = 'postgres://app_login:pw@localhost:5432/sifen';
    createNodePostgresDatabase.mockReturnValue({ db: {}, migrate: vi.fn(), close: vi.fn() });
    assertNonPrivilegedSession.mockRejectedValue(new Error('privileged session'));

    await expect(Test.createTestingModule({ imports: [DatabaseModule] }).compile()).rejects.toThrow(
      'privileged session',
    );
  });
});
