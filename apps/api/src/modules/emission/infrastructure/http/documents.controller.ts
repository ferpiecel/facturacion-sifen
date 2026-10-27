import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Res,
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
import type { createAcceptInvoice } from '../../application/accept-invoice.js';
import type {
  createAcceptCreditNote,
  createAcceptDebitNote,
} from '../../application/accept-credit-note.js';
import type {
  createAcceptRemission,
  createAcceptSelfInvoice,
} from '../../application/accept-standalone.js';
import type { createWaitForDocument } from '../../application/wait-for-document.js';
import {
  ACCEPT_CREDIT_NOTE,
  ACCEPT_DEBIT_NOTE,
  ACCEPT_INVOICE,
  ACCEPT_REMISSION,
  ACCEPT_SELF_INVOICE,
  WAIT_FOR_DOCUMENT,
} from '../../emission.tokens.js';
import { toRemissionDraft } from './remission.request.js';
import { toSelfInvoiceDraft } from './self-invoice.request.js';
import { toAcceptInvoiceInput } from './create-document.request.js';
import { parseDocumentRequest, toCreditNoteDraft } from './credit-note.request.js';
import { parseIdempotencyKey } from './idempotency-key.js';
import { toHttpException, validationProblem } from './document-http-errors.js';

/** The slice of the Fastify reply this controller needs (`status` only). */
interface StatusReply {
  status(code: number): unknown;
}

@Controller('v1/documents')
@RequireScopes('documents:write')
export class DocumentsController {
  constructor(
    @Inject(ACCEPT_INVOICE)
    private readonly acceptInvoice: ReturnType<typeof createAcceptInvoice>,
    @Inject(ACCEPT_CREDIT_NOTE)
    private readonly acceptCreditNote: ReturnType<typeof createAcceptCreditNote>,
    @Inject(ACCEPT_DEBIT_NOTE)
    private readonly acceptDebitNote: ReturnType<typeof createAcceptDebitNote>,
    @Inject(ACCEPT_SELF_INVOICE)
    private readonly acceptSelfInvoice: ReturnType<typeof createAcceptSelfInvoice>,
    @Inject(ACCEPT_REMISSION)
    private readonly acceptRemission: ReturnType<typeof createAcceptRemission>,
    @Inject(WAIT_FOR_DOCUMENT)
    private readonly waitForDocument: ReturnType<typeof createWaitForDocument>,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  /**
   * Accepts an FE (`type` absent or `FE`), NCE, NDE, AFE or NRE: `202 { document_id, cdc }`. Signing and transmission happen asynchronously.
   * `?wait=true` (HU-E6-06): for a tenant with synchronous transmission the response is held until SIFEN
   * settles the document (up to `SYNC_WAIT_TIMEOUT_MS`) and answers `200` with the final document;
   * otherwise the usual 202.
   * A retry with the same `Idempotency-Key` and body gets the same response; another body, 409.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Query('wait') wait: unknown,
    @Res({ passthrough: true }) reply: StatusReply,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const parsed = parseDocumentRequest(body);
    if (!parsed.ok) {
      throw validationProblem(parsed.errors);
    }
    try {
      const context = {
        tenantId: this.cls.get(TENANT_ID_CLS_KEY),
        actor: { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) } as const,
        payload: parsed.value,
        idempotencyKey,
      };
      const accepted =
        parsed.type === 'FE'
          ? await this.acceptInvoice(toAcceptInvoiceInput(parsed.value, context))
          : parsed.type === 'AFE'
            ? await this.acceptSelfInvoice({
                ...context,
                establishmentCode: parsed.value.establishment,
                expeditionPointCode: parsed.value.expeditionPoint,
                draft: toSelfInvoiceDraft(parsed.value),
              })
            : parsed.type === 'NRE'
              ? await this.acceptRemission({
                  ...context,
                  establishmentCode: parsed.value.establishment,
                  expeditionPointCode: parsed.value.expeditionPoint,
                  draft: toRemissionDraft(parsed.value),
                })
              : await (parsed.type === 'NCE' ? this.acceptCreditNote : this.acceptDebitNote)({
                  ...context,
                  establishmentCode: parsed.value.establishment,
                  expeditionPointCode: parsed.value.expeditionPoint,
                  draft: toCreditNoteDraft(parsed.value),
                });
      if (wait === 'true') {
        const settled = await this.waitForDocument(context.tenantId, accepted.documentId);
        if (settled) {
          void reply.status(HttpStatus.OK);
          return settled;
        }
      }
      return { document_id: accepted.documentId, cdc: accepted.cdc };
    } catch (error) {
      throw toHttpException(error) ?? error;
    }
  }
}
