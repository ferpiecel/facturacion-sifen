import { X509Certificate } from 'node:crypto';
import {
  createPgliteDatabase,
  tenantCertificates,
  tenantFiscalProfiles,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

    const opened = await vault.open(db, a, 'test');

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
    expect((await vault.open(db, a, 'test')).fingerprint).toBe(replaced.fingerprint);
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
    await expect(vault.open(db, a, 'test')).rejects.toThrow(CertificateNotFoundError);
    const { p12 } = issue();
    await vault.add(db, { tenantId: a, environment: 'test', p12, password: PASSWORD });
    await expect(vault.open(db, b, 'test')).rejects.toThrow(CertificateNotFoundError);
    await expect(vault.open(db, a, 'production')).rejects.toThrow(CertificateNotFoundError);
    await db
      .update(tenantCertificates)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(tenantCertificates.tenantId, a));
    await expect(vault.open(db, a, 'test')).rejects.toThrow(CertificateNotFoundError);
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
      .open(db, a, 'test')
      .catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(CertificateValidityError);
    expect((expired as CertificateValidityError).reason).toBe('expired');
    const early = await at(-5 * day)
      .open(db, a, 'test')
      .catch((e: unknown) => e);
    expect(early).toBeInstanceOf(CertificateValidityError);
    expect((early as CertificateValidityError).reason).toBe('not-yet-valid');
    expect((await at(0).open(db, a, 'test')).password).toBe(PASSWORD);
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
    await expect(vault.open(db, b, 'test')).rejects.toThrow(SecretDecryptionError);
  });
});
