import { createPgliteDatabase, tenantCertificates, tenants, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpsArgError, parseOpsArgs } from './args.js';
import { listExpiringCertificates } from './certificate-expiring.js';
import { runCli, runOpsCommand, type CliIo } from './ops.js';

// Real clock: runOpsCommand reads it. The extra hour keeps whole-day counts stable while tests run.
const NOW = new Date();
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000 + 3_600_000);

/** Spec: HU-E14 ops gaps. certificate:expiring lists active certificates about to expire; never certificate material. */
describe('certificate:expiring', () => {
  let handle: DatabaseHandle;
  let a: string;
  let b: string;
  let counter = 0;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    [{ id: a }, { id: b }] = await handle.db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning({ id: tenants.id });
  });
  afterEach(async () => {
    await handle.close();
  });

  // One active certificate per tenant and environment, so each active one gets its own tenant.
  async function certificate(
    tenantId: string | undefined,
    expiresInDays: number,
    status = 'active',
  ) {
    counter += 1;
    tenantId ??= (
      await handle.db
        .insert(tenants)
        .values({ name: `T${String(counter)}` })
        .returning({ id: tenants.id })
    )[0].id;
    return (
      await handle.db
        .insert(tenantCertificates)
        .values({
          tenantId,
          environment: 'test',
          sealed: { p12: 'SEALED-SECRET' },
          fingerprint: counter.toString(16).padStart(64, '0'),
          subjectRuc: '4490207-7',
          notBefore: daysFromNow(-300),
          notAfter: daysFromNow(expiresInDays),
          status,
          revokedAt: status === 'revoked' ? NOW : null,
        })
        .returning({ id: tenantCertificates.id, fingerprint: tenantCertificates.fingerprint })
    )[0];
  }

  it('lists active certificates expiring within the window, soonest first', async () => {
    const soon = await certificate(undefined, 5);
    const later = await certificate(undefined, 40);
    await certificate(undefined, 90, 'revoked');
    await certificate(undefined, 200);

    const rows = await listExpiringCertificates(handle.db, { days: 60 }, NOW);

    expect(rows.map((r) => [r.id, r.daysRemaining])).toEqual([
      [soon.id, 5],
      [later.id, 40],
    ]);
    expect(rows[0]).toMatchObject({ environment: 'test', fingerprint: soon.fingerprint });
  });

  it('ignores revoked certificates, and keeps an expired active one at a negative count', async () => {
    await certificate(undefined, 10, 'revoked');
    const expired = await certificate(undefined, -2);

    const rows = await listExpiringCertificates(handle.db, { days: 30 }, NOW);

    expect(rows.map((r) => [r.id, r.daysRemaining])).toEqual([[expired.id, -2]]);
  });

  it('reads one tenant when it is named', async () => {
    await certificate(a, 5);
    const other = await certificate(b, 6);

    const rows = await listExpiringCertificates(handle.db, { days: 30, tenantId: b }, NOW);

    expect(rows.map((r) => r.id)).toEqual([other.id]);
    await expect(
      listExpiringCertificates(handle.db, { days: 30, tenantId: 'nope' }, NOW),
    ).rejects.toThrow();
    await expect(listExpiringCertificates(handle.db, { days: 0 }, NOW)).rejects.toThrow('days');
    await expect(listExpiringCertificates(handle.db, { days: 366 }, NOW)).rejects.toThrow('days');
  });

  it('prints facts only, never the sealed material', async () => {
    const cert = await certificate(a, 5);

    const out = await runOpsCommand(
      handle.db,
      parseOpsArgs(['certificate:expiring', '--days', '30']),
    );

    expect(out).toContain(cert.id);
    expect(out).toContain(cert.fingerprint);
    expect(out).not.toContain('SEALED-SECRET');
    expect(
      await runOpsCommand(handle.db, parseOpsArgs(['certificate:expiring', '--days', '1'])),
    ).toBe('no active certificates expire within 1 days');
  });

  it('defaults the window to the largest CERTIFICATE_ALERT_DAYS threshold', async () => {
    await certificate(a, 40);
    const outputs: string[] = [];
    const io = (env: NodeJS.ProcessEnv): CliIo => ({
      argv: ['certificate:expiring'],
      env: { OPS_DATABASE_URL: 'postgres://x', ...env },
      readStdin: () => Promise.resolve(''),
      readFile: () => Buffer.alloc(0),
      out: (text) => outputs.push(text),
      err: (text) => outputs.push(`ERR ${text}`),
      openDb: () => ({ db: handle.db, close: () => Promise.resolve() }),
    });

    expect(await runCli(io({ CERTIFICATE_ALERT_DAYS: '45,10' }))).toBe(0);
    expect(await runCli(io({ CERTIFICATE_ALERT_DAYS: '20' }))).toBe(0);
    expect(outputs[0]).toContain('days');
    expect(outputs[0]).not.toContain('no active');
    expect(outputs[1]).toContain('no active certificates expire within 20 days');
  });

  it('parses the flags', () => {
    expect(parseOpsArgs(['certificate:expiring'])).toEqual({
      kind: 'certificate:expiring',
      tenantId: undefined,
      days: undefined,
    });
    expect(parseOpsArgs(['certificate:expiring', '--tenant', 't', '--days', '7'])).toEqual({
      kind: 'certificate:expiring',
      tenantId: 't',
      days: 7,
    });
    expect(() => parseOpsArgs(['certificate:expiring', '--days', 'x'])).toThrow(OpsArgError);
  });
});
