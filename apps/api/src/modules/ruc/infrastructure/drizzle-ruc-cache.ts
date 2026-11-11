import { and, eq } from 'drizzle-orm';
import { rucLookupCache, withAppRoleTransaction, type Database } from '@sifen/db';
import type { RucCache } from '../application/ports/ruc-cache.port.js';

/** `ruc_lookup_cache` is global registry data (no tenant), so it runs as `app_user` without a tenant context. */
export function createDrizzleRucCache(db: Database): RucCache {
  return {
    get: (environment, ruc) =>
      withAppRoleTransaction(db, async (tx) => {
        const rows = await tx
          .select()
          .from(rucLookupCache)
          .where(and(eq(rucLookupCache.environment, environment), eq(rucLookupCache.ruc, ruc)));
        const row = rows.at(0);
        if (row === undefined) return null;
        const contribuyente = row.found
          ? {
              ruc: row.ruc,
              razonSocial: row.razonSocial ?? '',
              estado: row.estado ?? '',
              facturadorElectronico: row.facturadorElectronico ?? false,
            }
          : null;
        return { found: row.found, contribuyente, fetchedAt: row.fetchedAt };
      }),
    put: (environment, ruc, answer, now) =>
      withAppRoleTransaction(db, async (tx) => {
        const values = {
          found: answer.found,
          razonSocial: answer.contribuyente?.razonSocial ?? null,
          estado: answer.contribuyente?.estado ?? null,
          facturadorElectronico: answer.contribuyente?.facturadorElectronico ?? null,
          fetchedAt: now,
        };
        await tx
          .insert(rucLookupCache)
          .values({ environment, ruc, ...values })
          .onConflictDoUpdate({
            target: [rucLookupCache.environment, rucLookupCache.ruc],
            set: values,
          });
      }),
  };
}
