import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CustodyModule } from './modules/custody/custody.module.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { EmissionModule } from './modules/emission/emission.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DatabaseModule,
    CustodyModule,
    IdentityModule,
    HealthModule,
    EmissionModule,
  ],
})
export class AppModule {}
