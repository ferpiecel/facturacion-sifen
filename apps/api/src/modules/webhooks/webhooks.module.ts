import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { EnvelopeCipher } from '../custody/application/envelope-cipher.js';
import { WebhookSecretVault } from '../custody/application/webhook-secret-vault.js';
import { CustodyModule } from '../custody/custody.module.js';
import { DATABASE } from '../database/database.module.js';
import { createWebhookDeliveryService } from './application/webhook-deliveries.js';
import { createWebhookEndpointService } from './application/webhook-endpoints.js';
import { createDrizzleWebhookDeliveryAdminStore } from './infrastructure/drizzle-webhook-delivery-admin-store.js';
import { createDrizzleWebhookEndpointStore } from './infrastructure/drizzle-webhook-endpoint-store.js';
import { WebhookDeliveriesController } from './infrastructure/http/webhook-deliveries.controller.js';
import { WebhookEndpointsController } from './infrastructure/http/webhook-endpoints.controller.js';
import { WEBHOOK_DELIVERIES, WEBHOOK_ENDPOINTS } from './webhooks.tokens.js';

/** Without a `DATABASE` the app still boots and `ApiKeyGuard` fails every request closed with 503. */
const unavailable = () => Promise.reject(new ServiceUnavailableException());

/** `/v1/webhooks/endpoints` and `/v1/webhooks/deliveries` (HU-E11-01 S5). */
@Module({
  imports: [CustodyModule],
  controllers: [WebhookEndpointsController, WebhookDeliveriesController],
  providers: [
    {
      provide: WEBHOOK_ENDPOINTS,
      useFactory: (db: Database | null, cipher: EnvelopeCipher) =>
        db
          ? createWebhookEndpointService({
              store: createDrizzleWebhookEndpointStore(db),
              vault: new WebhookSecretVault(cipher),
            })
          : { create: unavailable, list: unavailable, update: unavailable, rotate: unavailable },
      inject: [DATABASE, EnvelopeCipher],
    },
    {
      provide: WEBHOOK_DELIVERIES,
      useFactory: (db: Database | null) =>
        db
          ? createWebhookDeliveryService({ store: createDrizzleWebhookDeliveryAdminStore(db) })
          : { list: unavailable, replay: unavailable },
      inject: [DATABASE],
    },
  ],
})
export class WebhooksModule {}
