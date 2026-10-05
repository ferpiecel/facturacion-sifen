import { and, eq } from 'drizzle-orm';
import { auditLog, createPgliteDatabase, tenantCertificates, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestAuthority,
  issueTestPkcs12,
  type TestAuthority,
} from '../../test/support/test-pki.js';
import { CertificateNotFoundError } from '../modules/certificates/infrastructure/certificate-vault.js';
import { createFiscalProfile } from '../modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../modules/fiscal-config/domain/ruc.js';
import { OpsArgError, parseOpsArgs } from './args.js';
import { createTenant, setFiscalProfile } from './commands.js';
import { createCertificateVault, runCli } from './ops.js';

const PASSWORD = 'p12-super-secret';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ROOTS_PATH = '/etc/sifen/psc.pem';

let psc: TestAuthority;
beforeAll(() => {
  psc = createTestAuthority('Test PSC Root');
});

/** Spec: HU-E3-02 (slice 1). `certificate:revoke` revokes, audited and idempotent, never deleting the blob. */
describe('certificate:revoke', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const env = {
    KMS_LOCAL_MASTER_KEY: MASTER_KEY,
    NODE_ENV: 'test',
    PSC_TRUSTED_ROOTS_PATH: ROOTS_PATH,
  };
  const readFile = () => Buffer.from(psc.pem);

  async function seed() {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { db } = handle;
    const vault = createCertificateVault(env, readFile);
    const tenants: string[] = [];
    for (const [name, ruc] of [
      ['A', '80000005-6'],
      ['B', '80000006-4'],
    ] as const) {
      const { id } = await createTenant(db, name);
      await setFiscalProfile(db, {
        tenantId: id,
        profile: createFiscalProfile({
          ruc: parseRuc(ruc),
          legalName: `${name} S.A.`,
          taxpayerType: 'persona_juridica',
          economicActivities: [{ code: '62010', description: 'Programación informática' }],
        }),
      });
      tenants.push(id);
    }
    const [a, b] = tenants;
    const p12 = issueTestPkcs12(psc, { serialNumber: 'RUC80000005-6' }, PASSWORD).p12;
    const stored = await vault.add(db, {
      tenantId: a,
      environment: 'test',
      p12,
      password: PASSWORD,
    });
    const otherP12 = issueTestPkcs12(psc, { serialNumber: 'RUC80000006-4' }, PASSWORD).p12;
    await vault.add(db, { tenantId: b, environment: 'test', p12: otherP12, password: PASSWORD });
    return { db, vault, a, b, stored, p12 };
  }

  async function revoke(db: DatabaseHandle['db'], argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli({
      argv: ['certificate:revoke', ...argv],
      // No master key, no PSC roots: revoking needs neither, so the CLI must not ask for them.
      env: { OPS_DATABASE_URL: 'x' },
      readStdin: () => Promise.reject(new Error('revoke never reads stdin')),
      readFile: () => Promise.reject(new Error('revoke never reads files')),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      openDb: () => ({ db, close: () => Promise.resolve() }),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('revokes by id, keeps the sealed blob, audits it and stops signing from opening it', async () => {
    const { db, vault, a, stored } = await seed();
    const before = (
      await db.select().from(tenantCertificates).where(eq(tenantCertificates.id, stored.id))
    )[0];

    const result = await revoke(db, ['--tenant', a, '--id', stored.id]);

    expect(result.code).toBe(0);
    expect(result.out).toContain('certificate revoked');
    expect(result.out).toContain(stored.fingerprint);
    const after = (
      await db.select().from(tenantCertificates).where(eq(tenantCertificates.id, stored.id))
    )[0];
    expect(after).toMatchObject({ status: 'revoked', sealed: before.sealed });
    expect(after.revokedAt).toBeInstanceOf(Date);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'certificate.revoked'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: a,
      actorType: 'operator',
      entityType: 'certificate',
      entityId: stored.id,
    });
    expect(JSON.stringify(audits[0]) + result.out + result.err).not.toContain(PASSWORD);
    await expect(vault.open(db, a, 'test')).rejects.toThrow(CertificateNotFoundError);
  });

  it('revokes by fingerprint', async () => {
    const { db, a, stored } = await seed();
    const result = await revoke(db, ['--tenant', a, '--fingerprint', stored.fingerprint]);
    expect(result.code).toBe(0);
    const rows = await db
      .select()
      .from(tenantCertificates)
      .where(eq(tenantCertificates.tenantId, a));
    expect(rows.map((r) => r.status)).toEqual(['revoked']);
  });

  it('is idempotent: a second revoke succeeds, changes nothing and does not audit again', async () => {
    const { db, a, stored } = await seed();
    await revoke(db, ['--tenant', a, '--id', stored.id]);
    const first = (
      await db.select().from(tenantCertificates).where(eq(tenantCertificates.id, stored.id))
    )[0];

    const again = await revoke(db, ['--tenant', a, '--id', stored.id]);

    expect(again.code).toBe(0);
    expect(again.out).toContain('already revoked');
    const second = (
      await db.select().from(tenantCertificates).where(eq(tenantCertificates.id, stored.id))
    )[0];
    expect(second.revokedAt).toEqual(first.revokedAt);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'certificate.revoked')),
    ).toHaveLength(1);
  });

  it("never touches another tenant's certificate and reports it as not found", async () => {
    const { db, a, b, stored } = await seed();
    const result = await revoke(db, ['--tenant', b, '--id', stored.id]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('not found');
    const rows = await db
      .select()
      .from(tenantCertificates)
      .where(eq(tenantCertificates.tenantId, a));
    expect(rows.map((r) => r.status)).toEqual(['active']);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'certificate.revoked')),
    ).toEqual([]);
    const unknown = await revoke(db, ['--tenant', a, '--fingerprint', 'f'.repeat(64)]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('not found');
  });

  it('asks for --env when a fingerprint exists in both environments, then revokes only that one', async () => {
    const { db, vault, a, p12, stored } = await seed();
    await vault.add(db, { tenantId: a, environment: 'production', p12, password: PASSWORD });

    const ambiguous = await revoke(db, ['--tenant', a, '--fingerprint', stored.fingerprint]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('--env');

    const scoped = await revoke(db, [
      '--tenant',
      a,
      '--fingerprint',
      stored.fingerprint,
      '--env',
      'production',
    ]);
    expect(scoped.code).toBe(0);
    const rows = await db
      .select({ environment: tenantCertificates.environment, status: tenantCertificates.status })
      .from(tenantCertificates)
      .where(and(eq(tenantCertificates.tenantId, a)));
    expect(rows.sort((x, y) => x.environment.localeCompare(y.environment))).toEqual([
      { environment: 'production', status: 'revoked' },
      { environment: 'test', status: 'active' },
    ]);
  });

  describe('arguments', () => {
    const tenant = '3f1f6f0e-6d0a-4f43-9d6e-5a1c2b3d4e5f';
    it('requires a tenant and exactly one of --id or --fingerprint', () => {
      expect(parseOpsArgs(['certificate:revoke', '--tenant', tenant, '--id', 'abc'])).toEqual({
        kind: 'certificate:revoke',
        tenantId: tenant,
        id: 'abc',
        fingerprint: undefined,
        environment: undefined,
      });
      expect(
        parseOpsArgs([
          'certificate:revoke',
          '--tenant',
          tenant,
          '--fingerprint',
          'F'.repeat(64),
          '--env',
          'test',
        ]),
      ).toMatchObject({ fingerprint: 'f'.repeat(64), environment: 'test' });
      for (const argv of [
        ['--id', 'abc'],
        ['--tenant', tenant],
        ['--tenant', tenant, '--id', 'abc', '--fingerprint', 'f'.repeat(64)],
      ]) {
        expect(() => parseOpsArgs(['certificate:revoke', ...argv])).toThrow(OpsArgError);
      }
      expect(() =>
        parseOpsArgs(['certificate:revoke', '--tenant', tenant, '--fingerprint', 'not-hex']),
      ).toThrow(OpsArgError);
    });
  });
});
