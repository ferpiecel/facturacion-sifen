import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../identity/infrastructure/decorators/public.decorator.js';
import { RequireActiveTenant } from '../../identity/infrastructure/http/require-active-tenant.decorator.js';
import {
  CurrentSession,
  SessionGuard,
  type PortalSession,
} from '../../identity/infrastructure/http/session.guard.js';
import type { createGetPortalDocument } from '../application/get-portal-document.js';
import type { createListPortalDocuments } from '../application/list-portal-documents.js';
import { InvalidListQueryError, parseListQuery } from '../domain/list-query.js';
import { GET_PORTAL_DOCUMENT, LIST_PORTAL_DOCUMENTS } from '../portal-documents.tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `@RequireActiveTenant()` guarantees it; the guard runs before any handler. */
function tenantOf(session: PortalSession): string {
  return session.activeTenant?.tenantId ?? '';
}

/**
 * HU-E12-01/02: the portal's read-only view of the active tenant's documents. `@Public()` only opts out of the
 * API-key guard (a browser has no key); the {@link SessionGuard} authenticates, and the tenant is ALWAYS the
 * session's active one: the client never sends a tenant id. Every role may read.
 */
@Public()
@Controller('portal/documents')
@UseGuards(SessionGuard)
@RequireActiveTenant()
export class PortalDocumentsController {
  constructor(
    @Inject(LIST_PORTAL_DOCUMENTS)
    private readonly listDocuments: ReturnType<typeof createListPortalDocuments>,
    @Inject(GET_PORTAL_DOCUMENT)
    private readonly getDocument: ReturnType<typeof createGetPortalDocument>,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: Record<string, unknown>, @CurrentSession() session: PortalSession) {
    try {
      return this.listDocuments(tenantOf(session), parseListQuery(query));
    } catch (error) {
      if (error instanceof InvalidListQueryError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  async byId(@Param('id') id: string, @CurrentSession() session: PortalSession) {
    // A malformed id is a document that does not exist: the same 404 as another tenant's.
    const found = UUID.test(id) ? await this.getDocument(tenantOf(session), id) : null;
    if (!found) throw new NotFoundException('Document not found');
    return found;
  }
}
