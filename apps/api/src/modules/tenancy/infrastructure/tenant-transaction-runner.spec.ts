import { AsyncLocalStorage } from 'node:async_hooks';
import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { ClsService, type ClsStore } from 'nestjs-cls';
import { afterEach, describe, expect, it } from 'vitest';
import { MissingTenantContextError } from './missing-tenant-context.error.js';
import { TenantTransactionRunner } from './tenant-transaction-runner.js';

describe('TenantTransactionRunner', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('throws MissingTenantContextError when no tenant id is set on the CLS context', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const cls = new ClsService(new AsyncLocalStorage<ClsStore>());
    const runner = new TenantTransactionRunner(handle.db, cls);

    await expect(
      cls.run(() => runner.run(async (tx) => tx.execute('select 1'))),
    ).rejects.toThrow(MissingTenantContextError);
  });
});
