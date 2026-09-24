import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseHandle } from '@sifen/db';
import { ClsService } from 'nestjs-cls';
import { TenantTransactionRunner } from './infrastructure/tenant-transaction-runner.js';
import type { TenancyClsStore } from './infrastructure/tenancy-cls-store.js';

export interface TenancyModuleOptions {
  database: DatabaseHandle;
}

/**
 * Registered directly by callers that already hold a `DatabaseHandle`
 * (tests today). Tenant resolution comes from `ApiKeyGuard`
 * (`modules/identity`), which sets the CLS tenant id that
 * `TenantTransactionRunner` reads (HU-E1-04).
 */
@Module({})
export class TenancyModule {
  static register(options: TenancyModuleOptions): DynamicModule {
    return {
      module: TenancyModule,
      providers: [
        {
          provide: TenantTransactionRunner,
          useFactory: (cls: ClsService<TenancyClsStore>) =>
            new TenantTransactionRunner(options.database.db, cls),
          inject: [ClsService],
        },
      ],
      exports: [TenantTransactionRunner],
    };
  }
}
