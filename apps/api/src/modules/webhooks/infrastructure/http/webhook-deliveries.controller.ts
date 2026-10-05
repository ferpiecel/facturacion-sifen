import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';
import {
  API_KEY_ID_CLS_KEY,
  type IdentityClsStore,
} from '../../../identity/infrastructure/identity-cls-store.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import type { createWebhookDeliveryService } from '../../application/webhook-deliveries.js';
import { WEBHOOK_DELIVERIES } from '../../webhooks.tokens.js';
import { deliveryJson, toHttpException } from './webhook-http.js';

/** HU-E11-01 S5: delivery history (no payloads) and replay of dead deliveries. */
@Controller('v1/webhooks/deliveries')
export class WebhookDeliveriesController {
  constructor(
    @Inject(WEBHOOK_DELIVERIES)
    private readonly deliveries: ReturnType<typeof createWebhookDeliveryService>,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  @Get()
  @RequireScopes('webhooks:read')
  async list(@Query() query: Record<string, unknown>) {
    const page = await this.deliveries
      .list(this.cls.get(TENANT_ID_CLS_KEY), query)
      .catch((error: unknown) => {
        throw toHttpException(error);
      });
    return { items: page.items.map(deliveryJson), next_cursor: page.nextCursor };
  }

  @Post(':id/replay')
  @RequireScopes('webhooks:write')
  @HttpCode(HttpStatus.OK)
  async replay(@Param('id') id: string) {
    const actor = { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) } as const;
    const delivery = await this.deliveries
      .replay(this.cls.get(TENANT_ID_CLS_KEY), actor, id)
      .catch((error: unknown) => {
        throw toHttpException(error);
      });
    return deliveryJson(delivery);
  }
}
