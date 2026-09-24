import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule } from './modules/database/database.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  // IdentityModule (ApiKeyGuard as APP_GUARD) is not imported here yet:
  // that lands with the guard itself (HU-E1-04). DatabaseModule is global
  // and safe to mount now — it stays null (no-op) without DATABASE_URL.
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DatabaseModule,
    HealthModule,
  ],
})
export class AppModule {}
