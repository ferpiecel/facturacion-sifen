import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Query,
  StreamableFile,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../identity/infrastructure/decorators/public.decorator.js';
import { RequireActiveTenant } from '../../identity/infrastructure/http/require-active-tenant.decorator.js';
import {
  CurrentSession,
  SessionGuard,
  type PortalSession,
} from '../../identity/infrastructure/http/session.guard.js';
import type { createGetKude } from '../../emission/application/get-kude.js';
import { KudeSourceError } from '../../emission/application/kude-reader.js';
import type {
  createGetPortalDocument,
  createGetPortalXml,
} from '../application/get-portal-document.js';
import type { createListPortalDocuments } from '../application/list-portal-documents.js';
import { InvalidListQueryError, parseListQuery } from '../domain/list-query.js';
import {
  GET_PORTAL_DOCUMENT,
  GET_PORTAL_KUDE,
  GET_PORTAL_XML,
  LIST_PORTAL_DOCUMENTS,
} from '../portal-documents.tokens.js';

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
    @Inject(GET_PORTAL_XML) private readonly getXml: ReturnType<typeof createGetPortalXml>,
    @Inject(GET_PORTAL_KUDE) private readonly getKude: ReturnType<typeof createGetKude>,
  ) {}

  private readonly logger = new Logger(PortalDocumentsController.name);

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

  @Get(':id/xml')
  @Header('Cache-Control', 'private, no-store')
  async xml(@Param('id') id: string, @CurrentSession() session: PortalSession) {
    const result = UUID.test(id)
      ? await this.getXml(tenantOf(session), id)
      : ({ kind: 'not-found' } as const);
    if (result.kind === 'not-found') throw new NotFoundException('Signed XML not found');
    return new StreamableFile(Buffer.from(result.xml, 'utf8'), {
      type: 'application/xml',
      disposition: `attachment; filename="${result.cdc}.xml"`,
    });
  }

  @Get(':id/kude')
  @Header('Cache-Control', 'private, no-store')
  async kude(@Param('id') id: string, @CurrentSession() session: PortalSession) {
    if (!UUID.test(id)) throw new NotFoundException('Document not found');
    const result = await this.getKude(tenantOf(session), id).catch((error: unknown) => {
      if (!(error instanceof KudeSourceError)) throw error;
      // Field name only: neither the XML nor its values reach the log or the response.
      this.logger.error(`KuDE not printable for document ${id}: ${error.field}`);
      throw new UnprocessableEntityException('The KuDE cannot be generated for this document');
    });
    if (result.kind === 'not-found') throw new NotFoundException('Document not found');
    if (result.kind === 'not-signed') throw new ConflictException('Document is not signed yet');
    return new StreamableFile(result.pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${result.filename}"`,
    });
  }
}
