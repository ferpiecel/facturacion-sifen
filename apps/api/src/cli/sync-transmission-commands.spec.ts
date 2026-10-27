import {
  auditLog,
  createPgliteDatabase,
  tenantFiscalProfiles,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpsArgError, parseOpsArgs } from './args.js';
import { createTenant } from './commands.js';
import { runOpsCommand } from './ops.js';
import { setSyncTransmission } from './sync-transmission-commands.js';

/** Spec: HU-E6-06, the operator turns synchronous transmission on or off for one tenant. */
describe('setSyncTransmission', () => {
  let handle: DatabaseHandle;
  let tenantId: string;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantId = (await createTenant(handle.db, 'Acme')).id;
    await handle.db.insert(tenantFiscalProfiles).values({
      tenantId,
      rucBase: '80000005',
      rucDv: 6,
      legalName: 'Acme S.A.',
      taxpayerType: 'persona_juridica',
    });
  });
  afterEach(async () => {
    await handle.close();
  });

  const flag = async () =>
    (
      await handle.db
        .select({ on: tenantFiscalProfiles.syncTransmission })
        .from(tenantFiscalProfiles)
        .where(eq(tenantFiscalProfiles.tenantId, tenantId))
    )[0]?.on;

  it('sets and clears the flag', async () => {
    expect(await flag()).toBe(false);
    expect(await setSyncTransmission(handle.db, { tenantId, enabled: true, actor: 'ana' })).toEqual(
      {
        tenantId,
        enabled: true,
        changed: true,
      },
    );
    expect(await flag()).toBe(true);
    expect(
      await setSyncTransmission(handle.db, { tenantId, enabled: true, actor: 'ana' }),
    ).toMatchObject({
      changed: false,
    });
    await setSyncTransmission(handle.db, { tenantId, enabled: false, actor: 'ana' });
    expect(await flag()).toBe(false);
  });

  it('refuses a tenant without a fiscal profile', async () => {
    const other = (await createTenant(handle.db, 'Bare')).id;
    await expect(
      setSyncTransmission(handle.db, { tenantId: other, enabled: true, actor: 'ana' }),
    ).rejects.toThrow(/fiscal profile/);
  });

  it('parses and runs tenant:sync-transmission', async () => {
    const command = parseOpsArgs([
      'tenant:sync-transmission',
      '--tenant',
      tenantId,
      '--on',
      '--actor',
      'ana',
    ]);
    expect(command).toEqual({
      kind: 'tenant:sync-transmission',
      tenantId,
      enabled: true,
      actor: 'ana',
    });
    expect(await runOpsCommand(handle.db, command)).toContain('enabled');
    expect(() => parseOpsArgs(['tenant:sync-transmission', '--tenant', tenantId])).toThrow(
      OpsArgError,
    );
    expect(() => parseOpsArgs(['tenant:sync-transmission', '--tenant', tenantId, '--on'])).toThrow(
      /actor/,
    );
  });

  it('records the named actor in the audit entry', async () => {
    await setSyncTransmission(handle.db, { tenantId, enabled: true, actor: 'ana' });
    const [entry] = await handle.db
      .select({ actorType: auditLog.actorType, actorId: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.action, 'tenant.sync_transmission_set'));
    expect(entry).toEqual({ actorType: 'operator', actorId: 'ana' });
  });
});
