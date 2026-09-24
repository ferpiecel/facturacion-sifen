import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseHandle } from '@sifen/db';
import { ClsService } from 'nestjs-cls';
import { TestTenantHeaderGuard } from './infrastructure/guards/test-tenant-header.guard.js';
import { TenantTransactionRunner } from './infrastructure/tenant-transaction-runner.js';

export interface TenancyModuleOptions {
  database: DatabaseHandle;
}

/**
 * Registered directly by callers that already hold a `DatabaseHandle`
 * (tests today). `AppModule` only wires `ClsModule.forRoot(...)` for now;
 * it starts consuming `TenancyModule.register({ database })` once a real
 * handle exists, from HU-E1-04 on (design.md: "DB in AppModule — Later").
 */
@Module({})
export class TenancyModule {
  static register(options: TenancyModuleOptions): DynamicModule {
    return {
      module: TenancyModule,
      providers: [
        TestTenantHeaderGuard,
        {
          provide: TenantTransactionRunner,
          useFactory: (cls: ClsService) => new TenantTransactionRunner(options.database.db, cls),
          inject: [ClsService],
        },
      ],
      exports: [TestTenantHeaderGuard, TenantTransactionRunner],
    };
  }
}
