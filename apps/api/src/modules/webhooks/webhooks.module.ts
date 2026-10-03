import { Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@sifen/db';
import { EnvelopeCipher } from '../custody/application/envelope-cipher.js';
import { WebhookSecretVault } from '../custody/application/webhook-secret-vault.js';
import { CustodyModule } from '../custody/custody.module.js';
import { DATABASE } from '../database/database.module.js';
import { createWebhookEndpointService } from './application/webhook-endpoints.js';
import { createDrizzleWebhookEndpointStore } from './infrastructure/drizzle-webhook-endpoint-store.js';
import { WebhookEndpointsController } from './infrastructure/http/webhook-endpoints.controller.js';
import { WEBHOOK_ENDPOINTS } from './webhooks.tokens.js';

/** Without a `DATABASE` the app still boots and `ApiKeyGuard` fails every request closed with 503. */
const unavailable = () => Promise.reject(new ServiceUnavailableException());

/** `/v1/webhooks/endpoints` (HU-E11-01 S5). */
@Module({
  imports: [CustodyModule],
  controllers: [WebhookEndpointsController],
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
  ],
})
export class WebhooksModule {}
