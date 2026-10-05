import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
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
import type { createWebhookEndpointService } from '../../application/webhook-endpoints.js';
import { WEBHOOK_ENDPOINTS } from '../../webhooks.tokens.js';
import { asObject, endpointJson, parseId, toHttpException } from './webhook-http.js';

/** HU-E11-01 S5. The tenant comes from the API key; another tenant's endpoint is a 404. The secret is shown only by create and rotate. */
@Controller('v1/webhooks/endpoints')
export class WebhookEndpointsController {
  constructor(
    @Inject(WEBHOOK_ENDPOINTS)
    private readonly endpoints: ReturnType<typeof createWebhookEndpointService>,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  private get tenantId() {
    return this.cls.get(TENANT_ID_CLS_KEY);
  }
  private get actor() {
    return { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) } as const;
  }

  @Post()
  @RequireScopes('webhooks:write')
  @Header('Cache-Control', 'private, no-store') // the response carries the secret
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const { endpoint, secret } = await this.endpoints
      .create(this.tenantId, this.actor, asObject(body))
      .catch((error: unknown) => {
        throw toHttpException(error);
      });
    return { ...endpointJson(endpoint), secret };
  }

  @Get()
  @RequireScopes('webhooks:read')
  async list() {
    return (await this.endpoints.list(this.tenantId)).map(endpointJson);
  }

  @Patch(':id')
  @RequireScopes('webhooks:write')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const endpoint = await this.endpoints
      .update(this.tenantId, this.actor, parseId(id), asObject(body))
      .catch((error: unknown) => {
        throw toHttpException(error);
      });
    return endpointJson(endpoint);
  }

  @Post(':id/rotate-secret')
  @RequireScopes('webhooks:write')
  @Header('Cache-Control', 'private, no-store') // the response carries the secret
  @HttpCode(HttpStatus.OK)
  async rotate(@Param('id') id: string) {
    const { endpoint, secret } = await this.endpoints
      .rotate(this.tenantId, this.actor, parseId(id))
      .catch((error: unknown) => {
        throw toHttpException(error);
      });
    return { ...endpointJson(endpoint), secret };
  }
}
