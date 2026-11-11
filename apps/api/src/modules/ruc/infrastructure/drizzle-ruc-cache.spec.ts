import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { createDrizzleRucCache } from './drizzle-ruc-cache.js';

const acme = {
  ruc: '80012345',
  razonSocial: 'ACME SA',
  estado: 'ACT',
  facturadorElectronico: true,
};

describe('Drizzle RUC cache', () => {
  let handle: DatabaseHandle;
  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });
  afterEach(async () => {
    await handle.close();
  });

  it('misses on an unknown RUC', async () => {
    expect(await createDrizzleRucCache(handle.db).get('test', '80012345')).toBeNull();
  });

  it('round-trips a found taxpayer', async () => {
    const cache = createDrizzleRucCache(handle.db);
    const at = new Date('2026-10-27T12:00:00Z');
    await cache.put('test', '80012345', { found: true, contribuyente: acme }, at);
    expect(await cache.get('test', '80012345')).toEqual({
      found: true,
      contribuyente: acme,
      fetchedAt: at,
    });
  });

  it('stores a not-found answer and refreshes an existing entry', async () => {
    const cache = createDrizzleRucCache(handle.db);
    await cache.put('test', '80012345', { found: false, contribuyente: null }, new Date(1000));
    expect(await cache.get('test', '80012345')).toMatchObject({
      found: false,
      contribuyente: null,
    });
    const later = new Date(5000);
    await cache.put('test', '80012345', { found: true, contribuyente: acme }, later);
    expect(await cache.get('test', '80012345')).toMatchObject({ found: true, fetchedAt: later });
  });

  it('keeps the environments apart', async () => {
    const cache = createDrizzleRucCache(handle.db);
    await cache.put('test', '80012345', { found: true, contribuyente: acme }, new Date());
    expect(await cache.get('production', '80012345')).toBeNull();
  });
});
