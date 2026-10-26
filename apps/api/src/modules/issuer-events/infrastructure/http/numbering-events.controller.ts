import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
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
import type { createVoidNumbers } from '../../application/void-numbers.js';
import { VOID_NUMBERS } from '../../issuer-events.tokens.js';
import { toIssuerEventHttpException } from './issuer-event-http-errors.js';

/** Commands on the tenant's numbering that SIFEN knows as events (HU-E8-03). */
@Controller('v1/numbering')
@RequireScopes('documents:write')
export class NumberingEventsController {
  constructor(
    @Inject(VOID_NUMBERS) private readonly voidNumbers: ReturnType<typeof createVoidNumbers>,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  /**
   * Requests the voiding ("inutilización") of a range of numbers that will not be used: `202 { event_id,
   * status }`. The worker signs and sends the event; SIFEN's answer moves the rejected documents of the range
   * to `number_voided` (webhook `document.number_voided`). Retrying with the same `Idempotency-Key` and body
   * returns the same response.
   */
  @Post('inutilize')
  @HttpCode(HttpStatus.ACCEPTED)
  async inutilize(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    try {
      const result = await this.voidNumbers({
        tenantId: this.cls.get(TENANT_ID_CLS_KEY),
        actor: { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) },
        body,
        idempotencyKey,
      });
      return { event_id: result.eventId, status: result.status };
    } catch (error) {
      throw toIssuerEventHttpException(error) ?? error;
    }
  }
}
