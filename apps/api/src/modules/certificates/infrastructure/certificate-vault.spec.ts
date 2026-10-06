import { X509Certificate } from 'node:crypto';
import {
  auditLog,
  createPgliteDatabase,
  tenantCertificates,
  tenantFiscalProfiles,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestAuthority,
  issueTestPkcs12,
  type TestAuthority,
} from '../../../../test/support/test-pki.js';
import { EnvelopeCipher } from '../../custody/application/envelope-cipher.js';
import { SecretDecryptionError } from '../../custody/domain/sealed-secret.js';
import { createLocalKms } from '../../custody/infrastructure/adapters/local-kms.adapter.js';
import { Pkcs12UnreadableError } from '../domain/tenant-certificate.js';
import {
  ActiveCertificateExistsError,
  CertificateNotFoundError,
  CertificateRejectedError,
  CertificateValidityError,
  CertificateVault,
} from './certificate-vault.js';

let psc: TestAuthority;
beforeAll(() => {
  psc = createTestAuthority('Test PSC Root');
});

const PASSWORD = 'p12-secret-password';
const ACCESS = {
  actor: { type: 'system', id: 'transmission-worker' },
  purpose: 'signing',
} as const;

/** Spec: HU-E3-01 (slice 2). Tenant `.p12` custody: validate, seal, store, open in memory only. */
describe('CertificateVault', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function setup() {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [a, b, noProfile] = (
      await handle.db
        .insert(tenants)
        .values([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
        .returning()
    ).map((row) => row.id);
    await handle.db.insert(tenantFiscalProfiles).values([
      {
        tenantId: a,
        rucBase: '80000005',
        rucDv: 6,
        legalName: 'Tenant A S.A.',
        taxpayerType: 'persona_juridica',
      },
      {
        tenantId: b,
        rucBase: '80000005',
        rucDv: 6,
        legalName: 'Tenant B S.A.',
        taxpayerType: 'persona_juridica',
      },
    ]);
    const cipher = new EnvelopeCipher(createLocalKms(undefined, 'test', () => undefined));
    const vault = new CertificateVault(cipher, { trustedPscRoots: [new X509Certificate(psc.pem)] });
    return { db: handle.db, vault, cipher, a, b, noProfile };
  }

  const issue = (serialNumber = 'RUC80000005-6') =>
    issueTestPkcs12(psc, { serialNumber }, PASSWORD);

  it('validates, seals and stores the certificate with its public facts only', async () => {
    const { db, vault, a } = await setup();
    const { p12, leafPem } = issue();

    const stored = await vault.add(db, {
      tenantId: a,
      environment: 'test',
      p12,
      password: PASSWORD,
    });

    const leaf = new X509Certificate(leafPem);
    expect(stored).toMatchObject({
      subjectRuc: '80000005-6',
      notBefore: leaf.validFromDate,
      notAfter: leaf.validToDate,
    });
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const rows = await db.select().from(tenantCertificates);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', fingerprint: stored.fingerprint });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(p12.toString('base64'));
    expect(dump).not.toContain(PASSWORD);
  });

  it('opens the stored certificate in memory under the tenant scope', async () => {
    const { db, vault, a } = await setup();
    const { p12 } = issue();
    const stored = await vault.add(db, {
      tenantId: a,
      environment: 'test',
      p12,
      password: PASSWORD,
    });

    const opened = await vault.open(db, a, 'test', ACCESS);

    expect(Buffer.compare(opened.p12, p12)).toBe(0);
    expect(opened.password).toBe(PASSWORD);
    expect(opened.fingerprint).toBe(stored.fingerprint);
  });

  it('refuses an invalid certificate with every reason and stores nothing', async () => {
    const { db, vault, a } = await setup();
    const wrongRuc = issue('RUC80000006-4');
    const error = await vault
      .add(db, { tenantId: a, environment: 'test', p12: wrongRuc.p12, password: PASSWORD })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CertificateRejectedError);
    expect((error as CertificateRejectedError).rejections.map((r) => r.code)).toContain(
      'ruc-mismatch',
    );
    expect(await db.select().from(tenantCertificates)).toEqual([]);

    const foreignPki = issueTestPkcs12(
      createTestAuthority('Other CA'),
      {
        serialNumber: 'RUC80000005-6',
      },
      PASSWORD,
    );
    const untrusted = await vault
      .add(db, { tenantId: a, environment: 'test', p12: foreignPki.p12, password: PASSWORD })
      .catch((e: unknown) => e);
    expect((untrusted as CertificateRejectedError).rejections.map((r) => r.code)).toContain(
      'untrusted-chain',
    );
  });

  it('fails on a wrong password without echoing it', async () => {
    const { db, vault, a } = await setup();
    const { p12 } = issue();
    const error = await vault
      .add(db, { tenantId: a, environment: 'test', p12, password: 'wrong-password-123' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Pkcs12UnreadableError);
    expect((error as Error).message).not.toContain('wrong-password-123');
  });

  it('fails for an unknown tenant and for a tenant without a fiscal profile', async () => {
    const { db, vault, noProfile } = await setup();
    const { p12 } = issue();
    await expect(
      vault.add(db, {
        tenantId: '00000000-0000-4000-8000-000000000000',
        environment: 'test',
        p12,
        password: PASSWORD,
      }),
    ).rejects.toThrow('tenant not found');
    await expect(
      vault.add(db, { tenantId: noProfile, environment: 'test', p12, password: PASSWORD }),
    ).rejects.toThrow('fiscal profile');
  });

  it('keeps one active certificate per environment unless asked to replace it', async () => {
    const { db, vault, a } = await setup();
    const first = issue();
    const second = issue();
    const firstStored = await vault.add(db, {
      tenantId: a,
      environment: 'test',
      p12: first.p12,
      password: PASSWORD,
    });
    await expect(
      vault.add(db, { tenantId: a, environment: 'test', p12: second.p12, password: PASSWORD }),
    ).rejects.toThrow(ActiveCertificateExistsError);

    const replaced = await vault.add(db, {
      tenantId: a,
      environment: 'test',
      p12: second.p12,
      password: PASSWORD,
      replace: true,
    });

    const rows = await db.select().from(tenantCertificates);
    expect(rows.find((r) => r.fingerprint === firstStored.fingerprint)).toMatchObject({
      status: 'revoked',
    });
    expect(rows.find((r) => r.fingerprint === replaced.fingerprint)).toMatchObject({
      status: 'active',
    });
    expect((await vault.open(db, a, 'test', ACCESS)).fingerprint).toBe(replaced.fingerprint);
    // The other environment is independent.
    await vault.add(db, {
      tenantId: a,
      environment: 'production',
      p12: first.p12,
      password: PASSWORD,
    });
  });

  it('does not open a certificate that is missing, revoked or of another tenant', async () => {
    const { db, vault, a, b } = await setup();
    await expect(vault.open(db, a, 'test', ACCESS)).rejects.toThrow(CertificateNotFoundError);
    const { p12 } = issue();
    await vault.add(db, { tenantId: a, environment: 'test', p12, password: PASSWORD });
    await expect(vault.open(db, b, 'test', ACCESS)).rejects.toThrow(CertificateNotFoundError);
    await expect(vault.open(db, a, 'production', ACCESS)).rejects.toThrow(CertificateNotFoundError);
    await db
      .update(tenantCertificates)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(tenantCertificates.tenantId, a));
    await expect(vault.open(db, a, 'test', ACCESS)).rejects.toThrow(CertificateNotFoundError);
  });

  it('refuses to open a certificate outside its validity window at the clock time', async () => {
    const { db, vault, cipher, a } = await setup();
    const { p12 } = issue();
    await vault.add(db, { tenantId: a, environment: 'test', p12, password: PASSWORD });
    const day = 86_400_000;
    const at = (offset: number) =>
      new CertificateVault(cipher, {
        trustedPscRoots: [new X509Certificate(psc.pem)],
        now: () => new Date(Date.now() + offset),
      });

    const expired = await at(400 * day)
      .open(db, a, 'test', ACCESS)
      .catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(CertificateValidityError);
    expect((expired as CertificateValidityError).reason).toBe('expired');
    const early = await at(-5 * day)
      .open(db, a, 'test', ACCESS)
      .catch((e: unknown) => e);
    expect(early).toBeInstanceOf(CertificateValidityError);
    expect((early as CertificateValidityError).reason).toBe('not-yet-valid');
    expect((await at(0).open(db, a, 'test', ACCESS)).password).toBe(PASSWORD);
  });

  it("does not open a blob moved to another tenant's row (AAD)", async () => {
    const { db, vault, a, b } = await setup();
    const { p12 } = issue();
    await vault.add(db, { tenantId: a, environment: 'test', p12, password: PASSWORD });
    await vault.add(db, { tenantId: b, environment: 'test', p12: issue().p12, password: PASSWORD });
    const [rowA] = await db
      .select()
      .from(tenantCertificates)
      .where(eq(tenantCertificates.tenantId, a));
    // Immutable by trigger: emulate a swap by editing the table as its owner with triggers off.
    await db.execute(
      sql`alter table tenant_certificates disable trigger tenant_certificates_guard`,
    );
    await db
      .update(tenantCertificates)
      .set({ sealed: rowA.sealed })
      .where(and(eq(tenantCertificates.tenantId, b), eq(tenantCertificates.environment, 'test')));
    await expect(vault.open(db, b, 'test', ACCESS)).rejects.toThrow(SecretDecryptionError);
  });

  describe('sealed blob identity (AAD)', () => {
    async function swapSealed(
      db: DatabaseHandle['db'],
      from: typeof tenantCertificates.$inferSelect,
      to: typeof tenantCertificates.$inferSelect,
    ) {
      // The guard makes the sealed column immutable; emulate a tampered database as its owner.
      await db.execute(
        sql`alter table tenant_certificates disable trigger tenant_certificates_guard`,
      );
      await db
        .update(tenantCertificates)
        .set({ sealed: from.sealed })
        .where(eq(tenantCertificates.id, to.id));
    }

    it("does not open a blob moved to the same tenant's other environment", async () => {
      const { db, vault, a } = await setup();
      await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      await vault.add(db, {
        tenantId: a,
        environment: 'production',
        p12: issue().p12,
        password: PASSWORD,
      });
      const rows = await db.select().from(tenantCertificates);
      const test = rows.find((r) => r.environment === 'test');
      const production = rows.find((r) => r.environment === 'production');
      if (!test || !production) throw new Error('seed failed');
      await swapSealed(db, production, test);
      await expect(vault.open(db, a, 'test', ACCESS)).rejects.toThrow(SecretDecryptionError);
    });

    it('does not open a blob moved under another fingerprint of the same tenant', async () => {
      const { db, vault, a } = await setup();
      await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
        replace: true,
      });
      const rows = await db.select().from(tenantCertificates);
      const active = rows.find((r) => r.status === 'active');
      const revoked = rows.find((r) => r.status === 'revoked');
      if (!active || !revoked) throw new Error('seed failed');
      await swapSealed(db, revoked, active);
      await expect(vault.open(db, a, 'test', ACCESS)).rejects.toThrow(SecretDecryptionError);
    });
  });

  describe('audit (HU-E3-02)', () => {
    const audits = (db: DatabaseHandle['db']) => db.select().from(auditLog).orderBy(auditLog.seq);

    it('audits the first upload as certificate.added inside the write, without secrets', async () => {
      const { db, vault, a } = await setup();
      const { p12 } = issue();
      const stored = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12,
        password: PASSWORD,
      });

      const rows = await audits(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: a,
        actorType: 'operator',
        actorId: 'ops-cli',
        action: 'certificate.added',
        entityType: 'certificate',
        entityId: stored.id,
        before: null,
        after: {
          environment: 'test',
          fingerprint: stored.fingerprint,
          subjectRuc: '80000005-6',
          status: 'active',
        },
      });
      expect(JSON.stringify(rows)).not.toContain(PASSWORD);
      expect(JSON.stringify(rows)).not.toContain(p12.toString('base64'));
    });

    it('audits a replacement as certificate.replaced plus certificate.revoked for the old one', async () => {
      const { db, vault, a } = await setup();
      const first = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      const second = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
        replace: true,
      });

      const rows = (await audits(db)).filter(
        (r) => r.entityId !== first.id || r.action !== 'certificate.added',
      );
      expect(rows.map((r) => `${r.action}:${r.entityId}`).sort()).toEqual(
        [`certificate.replaced:${second.id}`, `certificate.revoked:${first.id}`].sort(),
      );
      const replaced = rows.find((r) => r.action === 'certificate.replaced');
      expect(replaced).toMatchObject({
        before: { previousId: first.id, fingerprint: first.fingerprint },
        after: { fingerprint: second.fingerprint, environment: 'test' },
      });
      expect(rows.find((r) => r.action === 'certificate.revoked')).toMatchObject({
        before: { status: 'active' },
        after: { status: 'revoked', environment: 'test', fingerprint: first.fingerprint },
      });
    });

    it('writes nothing when the upload is refused', async () => {
      const { db, vault, a } = await setup();
      await expect(
        vault.add(db, {
          tenantId: a,
          environment: 'test',
          p12: issue('RUC80000006-4').p12,
          password: PASSWORD,
        }),
      ).rejects.toThrow(CertificateRejectedError);
      expect(await audits(db)).toEqual([]);
    });

    it('audits each decrypt as certificate.accessed with actor and purpose, fingerprint only', async () => {
      const { db, vault, a } = await setup();
      const stored = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });

      await vault.open(db, a, 'test', ACCESS);

      const accessed = (await audits(db)).filter((r) => r.action === 'certificate.accessed');
      expect(accessed).toHaveLength(1);
      expect(accessed[0]).toMatchObject({
        tenantId: a,
        actorType: 'system',
        actorId: 'transmission-worker',
        entityType: 'certificate',
        entityId: stored.id,
        after: { environment: 'test', fingerprint: stored.fingerprint, purpose: 'signing' },
      });
      expect(JSON.stringify(accessed)).not.toContain(PASSWORD);
    });

    it('audits nothing when there is no usable certificate to access', async () => {
      const { db, vault, a } = await setup();
      await expect(vault.open(db, a, 'test', ACCESS)).rejects.toThrow(CertificateNotFoundError);
      expect(await audits(db)).toEqual([]);
    });

    it('fails closed: when the access cannot be audited nothing is decrypted', async () => {
      const { db, cipher, a } = await setup();
      const seeder = new CertificateVault(cipher, {
        trustedPscRoots: [new X509Certificate(psc.pem)],
      });
      await seeder.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      const open = vi.spyOn(cipher, 'open');
      const vault = new CertificateVault(cipher, {
        trustedPscRoots: [new X509Certificate(psc.pem)],
        recordAudit: () => Promise.reject(new Error('audit down')),
      });

      await expect(vault.open(db, a, 'test', ACCESS)).rejects.toThrow('audit down');
      expect(open).not.toHaveBeenCalled();
    });
  });

  describe('audit atomicity (HU-E3-02)', () => {
    const failing = (cipher: EnvelopeCipher, action: string) =>
      new CertificateVault(cipher, {
        trustedPscRoots: [new X509Certificate(psc.pem)],
        recordAudit: (_tx, entry) =>
          entry.action === action ? Promise.reject(new Error('audit down')) : Promise.resolve(),
      });

    it('stores no certificate when its audit row cannot be written', async () => {
      const { db, cipher, a } = await setup();
      await expect(
        failing(cipher, 'certificate.added').add(db, {
          tenantId: a,
          environment: 'test',
          p12: issue().p12,
          password: PASSWORD,
        }),
      ).rejects.toThrow('audit down');
      expect(await db.select().from(tenantCertificates)).toEqual([]);
    });

    it('keeps the old certificate active when the replacement cannot be audited', async () => {
      const { db, vault, cipher, a } = await setup();
      const first = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      await expect(
        failing(cipher, 'certificate.replaced').add(db, {
          tenantId: a,
          environment: 'test',
          p12: issue().p12,
          password: PASSWORD,
          replace: true,
        }),
      ).rejects.toThrow('audit down');
      const rows = await db.select().from(tenantCertificates);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.id, status: 'active', revokedAt: null });
    });

    it('keeps the access audit committed when the decrypt later fails', async () => {
      const { db, vault, a } = await setup();
      await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      await db.execute(
        sql`alter table tenant_certificates disable trigger tenant_certificates_guard`,
      );
      const [row] = await db.select().from(tenantCertificates);
      await db
        .update(tenantCertificates)
        .set({ sealed: { ...(row.sealed as object), ciphertext: 'AAAA' } });

      await expect(vault.open(db, a, 'test', ACCESS)).rejects.toThrow(SecretDecryptionError);

      const accessed = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'certificate.accessed'));
      expect(accessed).toHaveLength(1);
    });
  });

  describe('currentFingerprint (cache revalidation, HU-E3-02)', () => {
    it('returns the active, valid fingerprint without decrypting or auditing', async () => {
      const { db, vault, a } = await setup();
      const stored = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      const before = (await db.select().from(auditLog)).length;

      expect(await vault.currentFingerprint(db, a, 'test')).toBe(stored.fingerprint);
      expect(await vault.currentFingerprint(db, a, 'production')).toBeNull();
      expect((await db.select().from(auditLog)).length).toBe(before);
    });

    it('returns null once revoked, replaced-away or outside the validity window', async () => {
      const { db, vault, cipher, a } = await setup();
      const first = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
      });
      const second = await vault.add(db, {
        tenantId: a,
        environment: 'test',
        p12: issue().p12,
        password: PASSWORD,
        replace: true,
      });
      expect(await vault.currentFingerprint(db, a, 'test')).toBe(second.fingerprint);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      const later = new CertificateVault(cipher, {
        trustedPscRoots: [new X509Certificate(psc.pem)],
        now: () => new Date(Date.now() + 400 * 86_400_000),
      });
      expect(await later.currentFingerprint(db, a, 'test')).toBeNull();
      await db
        .update(tenantCertificates)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(tenantCertificates.id, second.id));
      expect(await vault.currentFingerprint(db, a, 'test')).toBeNull();
    });
  });
});
