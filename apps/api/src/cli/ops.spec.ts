import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTenant } from './commands.js';
import { formatOpsError, runOpsCommand } from './ops.js';

describe('runOpsCommand (HU-E1-05)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('partner:create prints the new partner id', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const output = await runOpsCommand(handle.db, { kind: 'partner:create', name: 'Acme' });

    expect(output).toMatch(/partner created: [0-9a-f-]{36}/);
  });

  it('tenant:create prints the new tenant id', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const output = await runOpsCommand(handle.db, {
      kind: 'tenant:create',
      name: 'Direct',
      partnerId: undefined,
    });

    expect(output).toMatch(/tenant created: [0-9a-f-]{36}/);
  });

  it('apikey:create prints the plaintext key exactly once, plus a warning it cannot be retrieved again', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Key Tenant');

    const output = await runOpsCommand(handle.db, {
      kind: 'apikey:create',
      tenantId,
      environment: 'test',
      scopes: ['documents:write'],
      label: undefined,
    });

    expect(output).toMatch(/^sk_test_/m);
    expect(output.toLowerCase()).toContain('cannot be retrieved again');
  });

  it('apikey:revoke prints a confirmation and never the secret', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Revoke Tenant');
    const issued = await runOpsCommand(handle.db, {
      kind: 'apikey:create',
      tenantId,
      environment: 'test',
      scopes: [],
      label: undefined,
    });
    const keyIdMatch = /sk_test_([A-Za-z0-9]{32})_/.exec(issued);
    const keyId = keyIdMatch?.[1] ?? '';

    const output = await runOpsCommand(handle.db, { kind: 'apikey:revoke', keyId });

    expect(output).toMatch(/revoked/i);
    expect(output).not.toContain('sk_test_');
  });
});

describe('formatOpsError (HU-E1-05)', () => {
  it('prints the driver cause, never the failed query params', () => {
    const driverError = new Error('insert or update on table "api_keys" violates foreign key');
    const queryError = new Error(
      'Failed query: insert into "api_keys"\nparams: keyId,$argon2id$hash',
      {
        cause: driverError,
      },
    );

    const message = formatOpsError(queryError);

    expect(message).toBe('insert or update on table "api_keys" violates foreign key');
    expect(message).not.toContain('argon2');
  });

  it('hides a failed query without a cause behind a generic message', () => {
    expect(formatOpsError(new Error('Failed query: select 1\nparams: secret'))).toBe(
      'database query failed',
    );
  });

  it('keeps plain operator errors as they are', () => {
    expect(formatOpsError(new Error('missing required --name'))).toBe('missing required --name');
  });

  it('describes a non-Error rejection generically', () => {
    expect(formatOpsError('boom')).toBe('unknown error');
  });
});
