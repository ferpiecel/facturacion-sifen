import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import type { createGetDocument } from '../../application/get-document.js';
import { GET_DOCUMENT } from '../../emission.tokens.js';
import { parseCdcQuery, parseDocumentId } from './document-query.js';

/** HU-E5-07. The tenant comes from the API key; another tenant's document is a 404. */
@Controller('v1/documents')
@RequireScopes('documents:read')
export class DocumentQueryController {
  constructor(
    @Inject(GET_DOCUMENT) private readonly getDocument: ReturnType<typeof createGetDocument>,
    private readonly cls: ClsService<TenancyClsStore>,
  ) {}

  @Get(':id')
  byId(@Param('id') id: string) {
    return this.find({ id: parseDocumentId(id) });
  }

  @Get()
  byCdc(@Query('cdc') cdc: unknown) {
    return this.find({ cdc: parseCdcQuery(cdc) });
  }

  private async find(by: { id: string } | { cdc: string }) {
    const found = await this.getDocument(this.cls.get(TENANT_ID_CLS_KEY), by);
    if (!found) throw new NotFoundException('Document not found');
    return found;
  }
}
