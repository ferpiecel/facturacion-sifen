import { HttpException, HttpStatus, Module } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { DATABASE } from '../database/database.module.js';
import { PortalAuthModule } from '../identity/portal-auth.module.js';
import { GetPartnerStatusUseCase } from './application/get-partner-status.use-case.js';
import { PartnerStatusController } from './infrastructure/partner-status.controller.js';
import { SqlPartnerStatusSource } from './infrastructure/sql-partner-status.adapter.js';
import { GET_PARTNER_STATUS } from './partners.tokens.js';

/** HU-E1-06 (ADR-0014). Without a `DATABASE` the app still boots and the route answers 503. */
@Module({
  imports: [PortalAuthModule],
  controllers: [PartnerStatusController],
  providers: [
    {
      provide: GET_PARTNER_STATUS,
      useFactory: (db: Database | null) => {
        if (!db) {
          return {
            execute: () => {
              throw new HttpException(
                'Partner status is unavailable',
                HttpStatus.SERVICE_UNAVAILABLE,
              );
            },
          };
        }
        return new GetPartnerStatusUseCase(new SqlPartnerStatusSource(db));
      },
      inject: [DATABASE],
    },
  ],
})
export class PartnersModule {}
