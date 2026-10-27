import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import type { RucCache, CachedRuc } from './ports/ruc-cache.port.js';
import { createLookupRuc, RucLookupDeniedError, RucLookupFailedError } from './lookup-ruc.js';

const acme = {
  ruc: '80012345',
  razonSocial: 'ACME SA',
  estado: 'ACT',
  facturadorElectronico: true,
};

function memoryCache() {
  const rows = new Map<string, CachedRuc>();
  const cache: RucCache = {
    get: (env, ruc) => Promise.resolve(rows.get(`${env}:${ruc}`) ?? null),
    put: (env, ruc, entry, now) => {
      rows.set(`${env}:${ruc}`, { ...entry, fetchedAt: now });
      return Promise.resolve();
    },
  };
  return { cache, rows };
}

function setup(ttlSeconds = 60) {
  const gateway = new FakeSifenGateway();
  const { cache, rows } = memoryCache();
  let now = new Date('2026-10-27T12:00:00Z');
  const lookup = createLookupRuc({
    gateway,
    cache,
    ttlSeconds,
    environment: 'test',
    now: () => now,
    nextDId: () => 7n,
  });
  return {
    gateway,
    rows,
    lookup,
    advance: (s: number) => (now = new Date(now.getTime() + s * 1000)),
  };
}

describe('LookupRuc', () => {
  it('asks SIFEN on a miss and returns the taxpayer', async () => {
    const { gateway, lookup } = setup();
    gateway.enqueue('consultarRUC', sifenScenarios.rucEncontrado(acme));
    const result = await lookup('80012345');
    expect(result).toEqual({ found: true, contribuyente: acme, cached: false });
    expect(gateway.callsTo('consultarRUC')).toEqual([[{ dId: 7n, ruc: '80012345' }]]);
  });

  it('serves a fresh entry from the cache without calling SIFEN', async () => {
    const { gateway, lookup, advance } = setup(60);
    gateway.enqueue('consultarRUC', sifenScenarios.rucEncontrado(acme));
    await lookup('80012345');
    advance(59);
    expect(await lookup('80012345')).toEqual({ found: true, contribuyente: acme, cached: true });
    expect(gateway.callsTo('consultarRUC')).toHaveLength(1);
  });

  it('asks SIFEN again once the entry is older than the TTL', async () => {
    const { gateway, lookup, advance } = setup(60);
    gateway.enqueue(
      'consultarRUC',
      sifenScenarios.rucEncontrado(acme),
      sifenScenarios.rucInexistente(),
    );
    await lookup('80012345');
    advance(60);
    expect(await lookup('80012345')).toEqual({ found: false, contribuyente: null, cached: false });
    expect(gateway.callsTo('consultarRUC')).toHaveLength(2);
  });

  it('caches a 0500 answer too', async () => {
    const { gateway, lookup } = setup();
    await lookup('80012345');
    expect(await lookup('80012345')).toMatchObject({ found: false, cached: true });
    expect(gateway.callsTo('consultarRUC')).toHaveLength(1);
  });

  it('never caches when the TTL is 0', async () => {
    const { gateway, lookup, rows } = setup(0);
    await lookup('80012345');
    await lookup('80012345');
    expect(gateway.callsTo('consultarRUC')).toHaveLength(2);
    expect(rows.size).toBe(0);
  });

  it('does not cache a 0501 and reports the denial', async () => {
    const { gateway, lookup, rows } = setup();
    gateway.enqueue('consultarRUC', sifenScenarios.rucSinPermisoConsulta());
    await expect(lookup('80012345')).rejects.toBeInstanceOf(RucLookupDeniedError);
    expect(rows.size).toBe(0);
  });

  it('rejects an unexpected code without caching it', async () => {
    const { gateway, lookup, rows } = setup();
    gateway.enqueue('consultarRUC', { dCodRes: '0160', dMsgRes: 'x', contribuyente: null });
    await expect(lookup('80012345')).rejects.toBeInstanceOf(RucLookupFailedError);
    expect(rows.size).toBe(0);
  });

  it('lets a gateway failure through and caches nothing', async () => {
    const { gateway, lookup, rows } = setup();
    gateway.enqueue('consultarRUC', new SifenTimeoutError('consultarRUC'));
    await expect(lookup('80012345')).rejects.toBeInstanceOf(SifenTimeoutError);
    expect(rows.size).toBe(0);
  });

  it('rejects a malformed RUC before any lookup', async () => {
    const { gateway, lookup } = setup();
    await expect(lookup('8001234-5')).rejects.toBeInstanceOf(RangeError);
    expect(gateway.calls).toHaveLength(0);
  });
});
