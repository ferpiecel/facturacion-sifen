import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { FakeSifenGateway, type SifenGateway } from '@sifen/sifen-gateway';
import { parseSifenEnvironment } from '../../bootstrap/environment.js';
import { DATABASE } from '../database/database.module.js';
import { createLookupRuc } from './application/lookup-ruc.js';
import { parseRucCacheTtl } from './application/ruc-cache-ttl.js';
import { createDrizzleRucCache } from './infrastructure/drizzle-ruc-cache.js';
import { RucController } from './infrastructure/http/ruc.controller.js';
import { LOOKUP_RUC, RUC_GATEWAY } from './ruc.tokens.js';

/**
 * The only SIFEN adapter that exists today is the simulator (the worker applies the same rule): it needs
 * `SIFEN_GATEWAY=simulator` and `NODE_ENV` of `development` or `test`. Otherwise the endpoint answers 503.
 */
function createRucGateway(env: NodeJS.ProcessEnv): SifenGateway | null {
  const allowed = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  return env.SIFEN_GATEWAY === 'simulator' && allowed ? new FakeSifenGateway() : null;
}

/** `GET /v1/ruc/:ruc` (HU-E6-09). `RUC_CACHE_TTL_SECONDS` is validated when the API boots. */
@Module({
  controllers: [RucController],
  providers: [
    { provide: RUC_GATEWAY, useFactory: () => createRucGateway(process.env) },
    {
      provide: LOOKUP_RUC,
      useFactory: (db: Database | null, gateway: SifenGateway | null) => {
        const ttlSeconds = parseRucCacheTtl(process.env.RUC_CACHE_TTL_SECONDS);
        const environment = parseSifenEnvironment(process.env.SIFEN_ENVIRONMENT);
        if (!db || !gateway) return () => Promise.reject(new ServiceUnavailableException());
        let sequence = 0n;
        return createLookupRuc({
          gateway,
          cache: createDrizzleRucCache(db),
          ttlSeconds,
          environment,
          now: () => new Date(),
          nextDId: () => BigInt(Date.now()) * 100n + (sequence++ % 100n),
        });
      },
      inject: [DATABASE, RUC_GATEWAY],
    },
  ],
})
export class RucModule {}
