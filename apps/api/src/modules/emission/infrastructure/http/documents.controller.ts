import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
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
import type { createAcceptSelfInvoice } from '../../application/accept-standalone.js';
import {
  ACCEPT_CREDIT_NOTE,
  ACCEPT_DEBIT_NOTE,
  ACCEPT_INVOICE,
  ACCEPT_SELF_INVOICE,
} from '../../emission.tokens.js';
import { toSelfInvoiceDraft } from './self-invoice.request.js';
import { toAcceptInvoiceInput } from './create-document.request.js';
import { parseDocumentRequest, toCreditNoteDraft } from './credit-note.request.js';
import { parseIdempotencyKey } from './idempotency-key.js';
import { toHttpException, validationProblem } from './document-http-errors.js';

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
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  /**
   * Accepts an FE (`type` absent or `FE`): `202 { document_id, cdc }`. Signing and transmission happen asynchronously.
   * A retry with the same `Idempotency-Key` and body gets the same response; another body, 409.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
  ) {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const parsed = parseDocumentRequest(body);
    if (!parsed.ok) {
      throw validationProblem(parsed.errors);
    }
    if (parsed.type === 'NRE') {
      // Routing arrives with R4 (HU-E7-04); until then the body is parsed but not accepted.
      throw validationProblem([
        { field: 'type', rule: 'type-not-supported', message: 'The NRE is not available yet' },
      ]);
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
            : await (parsed.type === 'NCE' ? this.acceptCreditNote : this.acceptDebitNote)({
                ...context,
                establishmentCode: parsed.value.establishment,
                expeditionPointCode: parsed.value.expeditionPoint,
                draft: toCreditNoteDraft(parsed.value),
              });
      return { document_id: accepted.documentId, cdc: accepted.cdc };
    } catch (error) {
      throw toHttpException(error) ?? error;
    }
  }
}
