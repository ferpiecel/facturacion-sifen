import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../../identity/infrastructure/decorators/public.decorator.js';
import { RequireActiveTenant } from '../../../identity/infrastructure/http/require-active-tenant.decorator.js';
import {
  CurrentSession,
  SessionGuard,
  type PortalSession,
} from '../../../identity/infrastructure/http/session.guard.js';
import type { createGetReceivedDocument } from '../../application/get-received-document.js';
import type { createListReceivedDocuments } from '../../application/list-received-documents.js';
import { GET_RECEIVED_DOCUMENT, LIST_RECEIVED_DOCUMENTS } from '../../reception.tokens.js';
import {
  presentReceivedDocumentDetail,
  presentReceivedDocumentPage,
} from './received-document.presenter.js';
import { receptionProblem } from './reception-http-errors.js';
import { asBadRequest, notFound, parseId } from './received-documents.controller.js';

/** `@RequireActiveTenant()` guarantees it; the guard runs before any handler. */
function tenantOf(session: PortalSession): string {
  return session.activeTenant?.tenantId ?? '';
}

/**
 * R7.1: the portal's READ-ONLY view of the active tenant's received documents. Same use cases and shapes as
 * `/v1/received-documents`, but authenticated by the portal session (`@Public()` only opts out of the API-key
 * guard) and with the tenant ALWAYS the session's active one. Uploads, corrections and reprocessing are
 * API-key only (`/v1`): this controller must never gain a write route.
 */
@Public()
@Controller('portal/received-documents')
@UseGuards(SessionGuard)
@RequireActiveTenant()
export class PortalReceivedDocumentsController {
  constructor(
    @Inject(LIST_RECEIVED_DOCUMENTS)
    private readonly listDocuments: ReturnType<typeof createListReceivedDocuments> | null,
    @Inject(GET_RECEIVED_DOCUMENT)
    private readonly getDocument: ReturnType<typeof createGetReceivedDocument> | null,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(@Query() query: Record<string, unknown>, @CurrentSession() session: PortalSession) {
    try {
      return presentReceivedDocumentPage(
        await this.require(this.listDocuments)(tenantOf(session), query),
      );
    } catch (error) {
      throw asBadRequest(error);
    }
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  async byId(@Param('id') id: string, @CurrentSession() session: PortalSession) {
    const detail = await this.require(this.getDocument)(tenantOf(session), parseId(id));
    if (detail === null) throw notFound();
    return presentReceivedDocumentDetail(detail);
  }

  private require<T>(useCase: T | null): T {
    if (useCase === null) {
      throw receptionProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'service_unavailable',
        'Reception is not available',
      );
    }
    return useCase;
  }
}
