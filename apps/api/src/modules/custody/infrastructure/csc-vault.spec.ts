import { createPgliteDatabase, tenantCscs, tenants, type DatabaseHandle } from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretDecryptionError } from '../domain/sealed-secret.js';
import { createLocalKms } from './adapters/local-kms.adapter.js';
import { CscVault, CscLimitError } from './csc-vault.js';
import { EnvelopeCipher } from '../application/envelope-cipher.js';

const VALUE = 'ABCD0000000000000000000000000000';

describe('CscVault (HU-E2-03)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function setup() {
    handle = createPgliteDatabase();
    await handle.migrate();
    const ids = (
      await handle.db
        .insert(tenants)
        .values([{ name: 'A' }, { name: 'B' }])
        .returning()
    ).map((row) => row.id);
    const [a, b] = ids;
    const cipher = new EnvelopeCipher(createLocalKms(undefined, 'test', () => undefined));
    return { db: handle.db, vault: new CscVault(cipher), a, b };
  }

  it('stores only the sealed blob and reads the plaintext back through RLS', async () => {
    const { db, vault, a } = await setup();

    await vault.add(db, { tenantId: a, environment: 'test', idCsc: '0001', value: VALUE });

    const rows = await db.select().from(tenantCscs);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
    const plaintext = await vault.getPlaintext(db, a, 'test', '0001');
    expect(plaintext.toString('utf8')).toBe(VALUE);
  });

  it('refuses the third CSC of an environment in the domain', async () => {
    const { db, vault, a } = await setup();
    await vault.add(db, { tenantId: a, environment: 'test', idCsc: '0001', value: VALUE });
    await vault.add(db, { tenantId: a, environment: 'test', idCsc: '0002', value: VALUE });

    await expect(
      vault.add(db, { tenantId: a, environment: 'test', idCsc: '0003', value: VALUE }),
    ).rejects.toThrow(CscLimitError);
  });

  it('fails for an unknown tenant and for a missing CSC', async () => {
    const { db, vault, a } = await setup();
    await expect(
      vault.add(db, {
        tenantId: '00000000-0000-4000-8000-000000000000',
        environment: 'test',
        idCsc: '0001',
        value: VALUE,
      }),
    ).rejects.toThrow('tenant not found');
    await expect(vault.getPlaintext(db, a, 'test', '0001')).rejects.toThrow('CSC not found');
  });

  it("does not open a tenant's blob under another tenant or environment (AAD)", async () => {
    const { db, vault, a, b } = await setup();
    await vault.add(db, { tenantId: a, environment: 'test', idCsc: '0001', value: VALUE });
    const [row] = await db.select().from(tenantCscs);

    // Move the blob to tenant B / production: AAD no longer matches.
    await db.insert(tenantCscs).values({ ...row, id: undefined, tenantId: b });
    await db
      .insert(tenantCscs)
      .values({
        tenantId: a,
        environment: 'production',
        idCsc: '0001',
        slot: 1,
        sealed: row.sealed,
      });

    await expect(vault.getPlaintext(db, b, 'test', '0001')).rejects.toThrow(SecretDecryptionError);
    await expect(vault.getPlaintext(db, a, 'production', '0001')).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  it('does not open a blob moved between slots of the same tenant and environment', async () => {
    const { db, vault, a } = await setup();
    await vault.add(db, { tenantId: a, environment: 'test', idCsc: '0001', value: VALUE });
    await vault.add(db, { tenantId: a, environment: 'test', idCsc: '0002', value: 'Z'.repeat(32) });
    const rows = await db.select().from(tenantCscs);
    const first = rows.find((r) => r.idCsc === '0001');
    const second = rows.find((r) => r.idCsc === '0002');
    await db
      .update(tenantCscs)
      .set({ sealed: second?.sealed })
      .where(eq(tenantCscs.id, first?.id ?? ''));

    await expect(vault.getPlaintext(db, a, 'test', '0001')).rejects.toThrow(SecretDecryptionError);
    expect((await vault.getPlaintext(db, a, 'test', '0002')).toString()).toBe('Z'.repeat(32));
  });

  it('accepts the CSC as a Buffer and stores it in the first free slot', async () => {
    const { db, vault, a } = await setup();
    await vault.add(db, {
      tenantId: a,
      environment: 'test',
      idCsc: '0007',
      value: Buffer.from(VALUE),
    });
    await vault.add(db, { tenantId: a, environment: 'test', idCsc: '0008', value: VALUE });

    const slots = (await db.select().from(tenantCscs)).map((r) => r.slot).sort();
    expect(slots).toEqual([1, 2]);
  });
});
