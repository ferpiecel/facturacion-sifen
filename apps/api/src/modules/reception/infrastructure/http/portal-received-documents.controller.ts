import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Inject,
  Param,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../../identity/infrastructure/decorators/public.decorator.js';
import { RequireActiveTenant } from '../../../identity/infrastructure/http/require-active-tenant.decorator.js';
import {
  CurrentSession,
  SessionGuard,
  type PortalSession,
} from '../../../identity/infrastructure/http/session.guard.js';
import type { createGetArtifact, createGetArtifactUrl } from '../../application/get-artifact.js';
import type { createGetReceivedDocument } from '../../application/get-received-document.js';
import type { createListReceivedDocuments } from '../../application/list-received-documents.js';
import {
  GET_RECEIVED_DOCUMENT,
  GET_RECEPTION_ARTIFACT,
  GET_RECEPTION_ARTIFACT_URL,
  LIST_RECEIVED_DOCUMENTS,
} from '../../reception.tokens.js';
import {
  presentReceivedDocumentDetail,
  presentReceivedDocumentPage,
} from './received-document.presenter.js';
import { receptionProblem } from './reception-http-errors.js';
import { asBadRequest, downloadName, notFound, parseId } from './received-documents.controller.js';

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
    @Inject(GET_RECEPTION_ARTIFACT)
    private readonly getArtifact: ReturnType<typeof createGetArtifact> | null,
    @Inject(GET_RECEPTION_ARTIFACT_URL)
    private readonly getArtifactUrl: ReturnType<typeof createGetArtifactUrl> | null,
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
    return presentReceivedDocumentDetail(detail, '/portal/received-documents');
  }

  /** The stored bytes, as uploaded; same hardening as `/v1` (`nosniff`, inline with a sanitized name). */
  @Get(':id/artifact')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async artifact(@Param('id') id: string, @CurrentSession() session: PortalSession) {
    const documentId = parseId(id);
    const download = await this.requireStorage(this.getArtifact)(tenantOf(session), documentId);
    if (download.kind === 'not-found') throw notFound();
    return new StreamableFile(download.bytes, {
      type: download.contentType,
      disposition: `inline; filename="${downloadName(download.originalName, documentId, download.contentType)}"`,
    });
  }

  /** A time-limited direct link to the stored bytes. */
  @Get(':id/artifact-url')
  @Header('Cache-Control', 'private, no-store')
  async artifactUrl(@Param('id') id: string, @CurrentSession() session: PortalSession) {
    const link = await this.requireStorage(this.getArtifactUrl)(tenantOf(session), parseId(id));
    if (link.kind === 'not-found') throw notFound();
    return { url: link.url, expires_in_seconds: link.expiresInSeconds };
  }

  private requireStorage<T>(useCase: T | null): T {
    if (useCase === null) {
      throw receptionProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'storage_unavailable',
        'Document storage is not available',
      );
    }
    return useCase;
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
