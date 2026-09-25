import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTenant } from './commands.js';
import { runOpsCommand } from './ops.js';

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
