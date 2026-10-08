import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CustodyModule } from './modules/custody/custody.module.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { EmissionModule } from './modules/emission/emission.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { PartnersModule } from './modules/partners/partners.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { PortalAuthModule } from './modules/identity/portal-auth.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DatabaseModule,
    CustodyModule,
    IdentityModule,
    PortalAuthModule,
    PartnersModule,
    HealthModule,
    EmissionModule,
    WebhooksModule,
  ],
})
export class AppModule {}
