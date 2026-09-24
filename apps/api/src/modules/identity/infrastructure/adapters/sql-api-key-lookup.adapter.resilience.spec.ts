import { Logger } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withAppRoleTransaction = vi.fn();

vi.mock('@sifen/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sifen/db')>();
  return {
    ...actual,
    withAppRoleTransaction: (...args: unknown[]) =>
      (withAppRoleTransaction as (...a: unknown[]) => unknown)(...args),
  };
});

const { SqlApiKeyLookupAdapter } = await import('./sql-api-key-lookup.adapter.js');

/**
 * These specs use a mocked `withAppRoleTransaction` (rather than the real
 * pglite path in `sql-api-key-lookup.adapter.spec.ts`) so they can force
 * conditions a schema-constrained real database never produces: a corrupt
 * `environment` value, and a rejected best-effort write.
 */
describe('SqlApiKeyLookupAdapter resilience', () => {
  afterEach(() => {
    withAppRoleTransaction.mockReset();
  });

  it('treats a row with an unrecognized environment value as not found', async () => {
    withAppRoleTransaction.mockResolvedValue([
      {
        id: 'id-1',
        tenant_id: 'tenant-1',
        secret_hash: 'hash',
        scopes: [],
        environment: 'staging',
      },
    ]);
    const adapter = new SqlApiKeyLookupAdapter({} as Database);

    await expect(adapter.resolveByKeyId('key')).resolves.toBeNull();
  });

  it('logs (via Nest Logger, not console.error) when touchLastUsed fails, without rejecting', async () => {
    withAppRoleTransaction.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const loggerSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = new SqlApiKeyLookupAdapter({} as Database);

    await expect(adapter.touchLastUsed('id-1')).resolves.toBeUndefined();

    expect(loggerSpy).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();

    loggerSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
