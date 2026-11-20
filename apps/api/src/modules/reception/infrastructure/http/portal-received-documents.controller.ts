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
import type { createGetArtifact } from '../../application/get-artifact.js';
import type { createGetReceivedDocument } from '../../application/get-received-document.js';
import type { createListReceivedDocuments } from '../../application/list-received-documents.js';
import {
  GET_RECEIVED_DOCUMENT,
  GET_RECEPTION_ARTIFACT,
  LIST_RECEIVED_DOCUMENTS,
} from '../../reception.tokens.js';
import {
  presentReceivedDocumentDetail,
  presentReceivedDocumentPage,
} from './received-document.presenter.js';
import { receptionProblem } from './reception-http-errors.js';
import { asBadRequest, downloadName, notFound, parseId } from './received-documents.controller.js';

/** Content types a browser can show without executing anything; the rest is downloaded. */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'";

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

  /**
   * The stored bytes, as uploaded. SECURITY: the bytes are third-party content (an XML ingested from a supplier is
   * kept raw before parsing) served from the PORTAL origin with the victim's session cookies, so a browser must never
   * render active content here. Only PDFs and raster images go `inline`; everything else (notably `application/xml`,
   * which a browser renders as XHTML/SVG and runs `<script>` or `xml-stylesheet` from) is an `attachment`. The CSP is
   * defense in depth: no script and no network from the document. The artifact CSP (`default-src 'none';
   * style-src 'unsafe-inline'`) and the page CSP that `apps/web/next.config.ts` sets on `/:path*` both reach
   * `/api/portal/*` through the proxy, so the browser enforces the two together. It is not verified that every
   * built-in PDF viewer renders under `object-src 'none'`; the download always works. `sandbox` is deliberately
   * NOT used: the built-in PDF viewers (Chrome, Firefox) refuse to render a PDF served with a sandboxing CSP, and the inline
   * allow-list already excludes anything that can run script. R7.5: XML (and any non-inline type) is a download, so
   * the viewer must offer it as a link, not embed it.
   */
  @Get(':id/artifact')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', ARTIFACT_CSP)
  async artifact(@Param('id') id: string, @CurrentSession() session: PortalSession) {
    const documentId = parseId(id);
    const download = await this.requireStorage(this.getArtifact)(tenantOf(session), documentId);
    if (download.kind === 'not-found') throw notFound();
    const mime = download.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    const disposition = INLINE_TYPES.has(mime) ? 'inline' : 'attachment';
    return new StreamableFile(download.bytes, {
      type: download.contentType,
      disposition: `${disposition}; filename="${downloadName(download.originalName, documentId, download.contentType)}"`,
    });
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
