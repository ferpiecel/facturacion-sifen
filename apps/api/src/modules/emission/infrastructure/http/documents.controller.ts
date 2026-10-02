import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
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
import { ACCEPT_INVOICE } from '../../emission.tokens.js';
import { parseCreateDocument, toAcceptInvoiceInput } from './create-document.request.js';
import { toHttpException, validationProblem } from './document-http-errors.js';

@Controller('v1/documents')
@RequireScopes('documents:write')
export class DocumentsController {
  constructor(
    @Inject(ACCEPT_INVOICE)
    private readonly acceptInvoice: ReturnType<typeof createAcceptInvoice>,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  /** Accepts an FE: `202 { document_id, cdc }`. Signing and transmission happen asynchronously. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@Body() body: unknown) {
    const parsed = parseCreateDocument(body);
    if (!parsed.ok) {
      throw validationProblem(parsed.errors);
    }
    try {
      const accepted = await this.acceptInvoice(
        toAcceptInvoiceInput(parsed.value, {
          tenantId: this.cls.get(TENANT_ID_CLS_KEY),
          actor: { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) },
          payload: body,
        }),
      );
      return { document_id: accepted.documentId, cdc: accepted.cdc };
    } catch (error) {
      throw toHttpException(error) ?? error;
    }
  }
}
