import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { parseIdempotencyKey } from '../../../emission/infrastructure/http/idempotency-key.js';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';
import {
  API_KEY_ID_CLS_KEY,
  type IdentityClsStore,
} from '../../../identity/infrastructure/identity-cls-store.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import type { createRegisterReceiverEvent } from '../../application/register-receiver-event.js';
import type { createCorrectReceiverEvent } from '../../application/correct-receiver-event.js';
import { CORRECT_RECEIVER_EVENT, REGISTER_RECEIVER_EVENT } from '../../issuer-events.tokens.js';
import { toIssuerEventHttpException } from './issuer-event-http-errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Events of the tenant as receiver of someone else's DE/DTE (HU-E9-01): asynchronous, answered 202. */
@Controller('v1/receiver-events')
@RequireScopes('documents:write')
export class ReceiverEventsController {
  constructor(
    @Inject(REGISTER_RECEIVER_EVENT)
    private readonly registerReceiverEvent: ReturnType<typeof createRegisterReceiverEvent>,
    @Inject(CORRECT_RECEIVER_EVENT)
    private readonly correctReceiverEvent: ReturnType<typeof createCorrectReceiverEvent>,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  /**
   * Registers a conformity, disconformity, unawareness or receipt notice over a CDC: `202 { event_id, kind,
   * cdc, status }`. The worker signs it with the tenant certificate and sends it to SIFEN. Retrying with the
   * same `Idempotency-Key` and body returns the same response.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async register(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    try {
      const result = await this.registerReceiverEvent({
        tenantId: this.cls.get(TENANT_ID_CLS_KEY),
        actor: { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) },
        body,
        idempotencyKey,
      });
      return {
        event_id: result.eventId,
        kind: result.kind,
        cdc: result.cdc,
        status: result.status,
      };
    } catch (error) {
      throw toIssuerEventHttpException(error) ?? error;
    }
  }

  /** Corrects an approved event (HU-E9-02): the replacement event plus `correctionReason`; 202 like the registration. */
  @Post(':id/correct')
  @HttpCode(HttpStatus.ACCEPTED)
  async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    if (!UUID.test(id)) throw new BadRequestException('id must be a UUID');
    try {
      const result = await this.correctReceiverEvent({
        tenantId: this.cls.get(TENANT_ID_CLS_KEY),
        actor: { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) },
        eventId: id,
        body,
        idempotencyKey,
      });
      return {
        event_id: result.eventId,
        corrects_event_id: result.correctsEventId,
        kind: result.kind,
        cdc: result.cdc,
        status: result.status,
      };
    } catch (error) {
      throw toIssuerEventHttpException(error) ?? error;
    }
  }
}
