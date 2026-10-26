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
import type { createCancelDocument } from '../../application/cancel-document.js';
import { CANCEL_DOCUMENT } from '../../issuer-events.tokens.js';
import { toIssuerEventHttpException } from './issuer-event-http-errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Commands on an issued document that SIFEN knows as events (HU-E8-02): all asynchronous, answered 202. */
@Controller('v1/documents')
@RequireScopes('documents:write')
export class IssuerEventsController {
  constructor(
    @Inject(CANCEL_DOCUMENT)
    private readonly cancelDocument: ReturnType<typeof createCancelDocument>,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  /**
   * Requests the cancellation of an approved document: `202 { event_id, document_id, status }`. The worker
   * signs and sends the event; the document becomes `cancelled` when SIFEN registers it (webhook
   * `document.cancelled`). Retrying with the same `Idempotency-Key` and body returns the same response.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    if (!UUID.test(id)) throw new BadRequestException('id must be a UUID');
    const reason =
      typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
    try {
      const result = await this.cancelDocument({
        tenantId: this.cls.get(TENANT_ID_CLS_KEY),
        actor: { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) },
        documentId: id,
        reason,
        idempotencyKey,
      });
      return { event_id: result.eventId, document_id: result.documentId, status: result.status };
    } catch (error) {
      throw toIssuerEventHttpException(error) ?? error;
    }
  }
}
