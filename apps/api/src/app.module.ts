import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ApiDocsModule } from './modules/api-docs/api-docs.module.js';
import { CustodyModule } from './modules/custody/custody.module.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { EmissionModule } from './modules/emission/emission.module.js';
import { IssuerEventsModule } from './modules/issuer-events/issuer-events.module.js';
import { GeoModule } from './modules/geo/geo.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { PartnersModule } from './modules/partners/partners.module.js';
import { PortalDocumentsModule } from './modules/portal-documents/portal-documents.module.js';
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
    PortalDocumentsModule,
    HealthModule,
    ApiDocsModule,
    EmissionModule,
    IssuerEventsModule,
    WebhooksModule,
    GeoModule,
  ],
})
export class AppModule {}
