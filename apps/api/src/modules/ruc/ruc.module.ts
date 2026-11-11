import { readFileSync } from 'node:fs';
import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { readBoundedFile } from '../../cli/bounded-file.js';
import { createCertificateVault } from '../../cli/ops.js';
import { CachedCertificateVault } from '../certificates/infrastructure/cached-certificate-vault.js';
import { createDrizzleTenantEnvironment } from '../transmission/infrastructure/drizzle-tenant-environment.js';
import { DATABASE } from '../database/database.module.js';
import { createLookupRuc } from './application/lookup-ruc.js';
import { parseRucCacheTtl } from './application/ruc-cache-ttl.js';
import { createDrizzleRucCache } from './infrastructure/drizzle-ruc-cache.js';
import { RucController } from './infrastructure/http/ruc.controller.js';
import { createRucGateways, type RucGateways } from './infrastructure/ruc-gateways.js';
import { LOOKUP_RUC, RUC_GATEWAY } from './ruc.tokens.js';

const RUC_ACTOR = { type: 'system', id: 'ruc-lookup' } as const;

/**
 * `GET /v1/ruc/:ruc` (HU-E6-09). `RUC_CACHE_TTL_SECONDS` is validated when the API boots, and so are
 * the SOAP settings when `SIFEN_GATEWAY=soap` (each tenant calls SIFEN with its own certificate).
 */
@Module({
  controllers: [RucController],
  providers: [
    {
      provide: RUC_GATEWAY,
      useFactory: (db: Database | null): RucGateways | null =>
        createRucGateways(process.env, {
          readFile: (path) => readFileSync(path, 'utf8'),
          soap: () => {
            if (!db) return null;
            const vault = new CachedCertificateVault(
              createCertificateVault(process.env, readBoundedFile),
            );
            return {
              environments: createDrizzleTenantEnvironment(db),
              certificates: {
                open: (tenantId, environment) =>
                  vault.open(db, tenantId, environment, {
                    actor: RUC_ACTOR,
                    purpose: 'sifen-mtls',
                  }),
              },
              logger: {
                warn: (message) => {
                  console.warn(message);
                },
              },
            };
          },
        }),
      inject: [DATABASE],
    },
    {
      provide: LOOKUP_RUC,
      useFactory: (db: Database | null, gateways: RucGateways | null) => {
        const ttlSeconds = parseRucCacheTtl(process.env.RUC_CACHE_TTL_SECONDS);
        if (!db || !gateways) return () => Promise.reject(new ServiceUnavailableException());
        let sequence = 0n;
        return createLookupRuc({
          gatewayFor: (tenantId) => gateways.gatewayFor(tenantId),
          environmentOf: (tenantId) => gateways.environmentOf(tenantId),
          cache: createDrizzleRucCache(db),
          ttlSeconds,
          now: () => new Date(),
          nextDId: () => BigInt(Date.now()) * 100n + (sequence++ % 100n),
        });
      },
      inject: [DATABASE, RUC_GATEWAY],
    },
  ],
})
export class RucModule {}
