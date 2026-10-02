import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDatabase, tenantCscs, tenants, type DatabaseHandle } from '@sifen/db';
import { EnvelopeCipher } from '../../custody/application/envelope-cipher.js';
import { createLocalKms } from '../../custody/infrastructure/adapters/local-kms.adapter.js';
import { CscVault } from '../../custody/infrastructure/csc-vault.js';
import { createCertificateSource, createCscSource } from './signing-sources.js';

describe('signing sources (HU-E6-02, S4b)', () => {
  let handle: DatabaseHandle;
  let a: string;
  let b: string;
  let vault: CscVault;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    [a, b] = (
      await handle.db
        .insert(tenants)
        .values([{ name: 'A' }, { name: 'B' }])
        .returning()
    ).map((row) => row.id);
    vault = new CscVault(new EnvelopeCipher(createLocalKms(undefined, 'test', () => undefined)));
  });

  afterEach(async () => {
    await handle.close();
  });

  const addCsc = (
    tenantId: string,
    environment: 'test' | 'production',
    idCsc: string,
    value: string,
  ) => vault.add(handle.db, { tenantId, environment, idCsc, value });

  describe('createCscSource', () => {
    it('opens the CSC of the lowest slot for the environment', async () => {
      await addCsc(a, 'test', '0001', 'AAAA0000000000000000000000000001');
      await addCsc(a, 'test', '0002', 'BBBB0000000000000000000000000002');
      const csc = await createCscSource({ db: handle.db, vault }).get(a, 'test');
      expect(csc?.idCsc).toBe('0001');
      expect(csc?.value.toString('utf8')).toBe('AAAA0000000000000000000000000001');
    });

    it('falls back to the next slot when slot 1 is free', async () => {
      await addCsc(a, 'test', '0001', 'AAAA0000000000000000000000000001');
      await addCsc(a, 'test', '0002', 'BBBB0000000000000000000000000002');
      await handle.db.delete(tenantCscs).where(eq(tenantCscs.idCsc, '0001'));
      const csc = await createCscSource({ db: handle.db, vault }).get(a, 'test');
      expect(csc?.idCsc).toBe('0002');
    });

    it('is null without a CSC for that environment or tenant', async () => {
      await addCsc(a, 'production', '0001', 'AAAA0000000000000000000000000001');
      const source = createCscSource({ db: handle.db, vault });
      expect(await source.get(a, 'test')).toBeNull();
      expect(await source.get(b, 'production')).toBeNull();
      expect((await handle.db.select().from(tenantCscs)).length).toBe(1);
    });
  });

  describe('createCertificateSource', () => {
    it('delegates to the vault with the tenant and environment', async () => {
      const calls: unknown[][] = [];
      const certificate = { p12: Buffer.from('p12'), password: 'pw' };
      const source = createCertificateSource({
        db: handle.db,
        vault: {
          open: (_db, tenantId, environment) => {
            calls.push([tenantId, environment]);
            return Promise.resolve(certificate);
          },
        },
      });
      expect(await source.open(a, 'production')).toBe(certificate);
      expect(calls).toEqual([[a, 'production']]);
    });

    it('lets the vault errors through', async () => {
      const source = createCertificateSource({
        db: handle.db,
        vault: { open: () => Promise.reject(new RangeError('no active certificate')) },
      });
      await expect(source.open(a, 'test')).rejects.toThrow(RangeError);
    });
  });
});
