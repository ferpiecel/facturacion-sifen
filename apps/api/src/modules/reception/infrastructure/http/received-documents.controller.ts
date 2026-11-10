import {
  Body,
  Controller,
  Get,
  Header,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import type { createGetArtifact, createGetArtifactUrl } from '../../application/get-artifact.js';
import type { createGetReceivedDocument } from '../../application/get-received-document.js';
import type { IngestSifenXml } from '../../application/ingest-sifen-xml.js';
import {
  InvalidReceivedDocumentQueryError,
  type createListReceivedDocuments,
} from '../../application/list-received-documents.js';
import type { ReceivedDocument } from '../../domain/received-document.js';
import {
  GET_RECEIVED_DOCUMENT,
  GET_RECEPTION_ARTIFACT,
  GET_RECEPTION_ARTIFACT_URL,
  INGEST_SIFEN_XML,
  LIST_RECEIVED_DOCUMENTS,
  RECEPTION_UPLOAD_CONFIG,
} from '../../reception.tokens.js';
import {
  presentReceivedDocumentDetail,
  presentReceivedDocumentPage,
} from './received-document.presenter.js';
import { receptionProblem } from './reception-http-errors.js';
import type { ReceptionUploadConfig } from './reception-upload-config.js';
import { sniffUpload } from './upload-sniff.js';

interface HttpRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  file(options: {
    limits: { fileSize: number };
  }): Promise<{ filename?: string; toBuffer(): Promise<Buffer> } | undefined>;
}

interface HttpReply {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
}

interface Upload {
  readonly bytes: Uint8Array;
  readonly originalName: string | null;
}

const MAX_FILENAME_LENGTH = 255;

const tooLarge = () =>
  receptionProblem(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'payload_too_large',
    'The upload exceeds the maximum allowed size',
  );

/**
 * Reception API. `POST` stores a SIFEN XML (R4.2); the `GET` routes list, read and download
 * (R4.3). Scopes: `reception:write` uploads, corrects, confirms and reprocesses; `reception:read`
 * reads.
 */
@Controller('v1/received-documents')
export class ReceivedDocumentsController {
  constructor(
    @Inject(INGEST_SIFEN_XML) private readonly ingest: IngestSifenXml | null,
    @Inject(RECEPTION_UPLOAD_CONFIG) private readonly config: ReceptionUploadConfig,
    @Inject(LIST_RECEIVED_DOCUMENTS)
    private readonly listDocuments: ReturnType<typeof createListReceivedDocuments> | null,
    @Inject(GET_RECEIVED_DOCUMENT)
    private readonly getDocument: ReturnType<typeof createGetReceivedDocument> | null,
    @Inject(GET_RECEPTION_ARTIFACT)
    private readonly getArtifact: ReturnType<typeof createGetArtifact> | null,
    @Inject(GET_RECEPTION_ARTIFACT_URL)
    private readonly getArtifactUrl: ReturnType<typeof createGetArtifactUrl> | null,
    private readonly cls: ClsService<TenancyClsStore>,
  ) {}

  /**
   * Accepts an upload (raw XML, multipart `file` or JSON `{ xml }`): 202 with `Location` for a new
   * document, 200 when the same bytes or the same CDC were already received. Only SIFEN XML is
   * processed today; PDF, photos and CDC-only requests answer 422 `unsupported_source`.
   */
  @Post()
  @RequireScopes('reception:write')
  async upload(
    @Req() request: HttpRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    if (this.ingest === null) {
      throw receptionProblem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'storage_unavailable',
        'Document storage is not available',
      );
    }
    const upload = await this.readUpload(request, body);
    if (upload.bytes.byteLength === 0) {
      throw receptionProblem(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'empty_upload',
        'The upload is empty',
      );
    }
    if (upload.bytes.byteLength > this.config.maxBytes) throw tooLarge();
    switch (sniffUpload(upload.bytes)) {
      case 'xml':
        break;
      case 'pdf':
      case 'image':
        throw unsupportedSource();
      default:
        throw notXml();
    }

    const result = await this.ingest.execute({
      tenantId: this.cls.get(TENANT_ID_CLS_KEY),
      xml: upload.bytes,
      originalName: upload.originalName,
    });
    // Seam (R4.5): `result.events` must be enqueued as webhook outbox rows here, in the same
    // transaction as the document, once the reception event emitter exists. Nothing is enqueued yet.
    const { document } = result;
    if (document.status === 'extraction_failed') {
      throw receptionProblem(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'extraction_failed',
        'The XML could not be read as a supported SIFEN document',
        { document_id: document.id },
      );
    }
    reply.status(result.created ? HttpStatus.ACCEPTED : HttpStatus.OK);
    reply.header('location', `/v1/received-documents/${document.id}`);
    return present(document);
  }

  /** Newest first, keyset paged; every filter is optional and malformed ones answer 400. */
  @Get()
  @RequireScopes('reception:read')
  async list(@Query() query: Record<string, unknown>) {
    const listDocuments = this.require(this.listDocuments);
    try {
      return presentReceivedDocumentPage(await listDocuments(this.tenantId(), query));
    } catch (error) {
      throw asBadRequest(error);
    }
  }

  @Get(':id')
  @RequireScopes('reception:read')
  async byId(@Param('id') id: string) {
    const detail = await this.require(this.getDocument)(this.tenantId(), parseId(id));
    if (detail === null) throw notFound();
    return presentReceivedDocumentDetail(detail);
  }

  /** The stored bytes, as uploaded. */
  @Get(':id/artifact')
  @RequireScopes('reception:read')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async artifact(@Param('id') id: string) {
    const documentId = parseId(id);
    const download = await this.requireStorage(this.getArtifact)(this.tenantId(), documentId);
    if (download.kind === 'not-found') throw notFound();
    return new StreamableFile(download.bytes, {
      type: download.contentType,
      disposition: `inline; filename="${downloadName(download.originalName, documentId, download.contentType)}"`,
    });
  }

  /** A time-limited direct link to the stored bytes. */
  @Get(':id/artifact-url')
  @RequireScopes('reception:read')
  @Header('Cache-Control', 'private, no-store')
  async artifactUrl(@Param('id') id: string) {
    const link = await this.requireStorage(this.getArtifactUrl)(this.tenantId(), parseId(id));
    if (link.kind === 'not-found') throw notFound();
    return { url: link.url, expires_in_seconds: link.expiresInSeconds };
  }

  private tenantId(): string {
    return this.cls.get(TENANT_ID_CLS_KEY);
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

  private async readUpload(request: HttpRequest, body: unknown): Promise<Upload> {
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    if (contentType.startsWith('multipart/')) return this.readMultipart(request);
    if (contentType.startsWith('application/json')) return readJson(body);
    if (!Buffer.isBuffer(body)) throw notXml();
    return { bytes: body, originalName: null };
  }

  private async readMultipart(request: HttpRequest): Promise<Upload> {
    const part = await request.file({ limits: { fileSize: this.config.maxBytes } });
    if (part === undefined) {
      throw receptionProblem(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'invalid_request',
        'A file part is required',
      );
    }
    try {
      const name = part.filename?.split(/[\\/]/).at(-1)?.slice(0, MAX_FILENAME_LENGTH);
      return { bytes: await part.toBuffer(), originalName: name ? name : null };
    } catch (error) {
      if ((error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
      throw error;
    }
  }
}

function readJson(body: unknown): Upload {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof record.xml === 'string') {
    return { bytes: Buffer.from(record.xml, 'utf8'), originalName: null };
  }
  if (typeof record.cdc === 'string' && record.xml === undefined) throw unsupportedSource();
  throw receptionProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'invalid_request',
    'Expected a JSON body with a string "xml"',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalidRequest = (message: string) =>
  receptionProblem(HttpStatus.BAD_REQUEST, 'invalid_request', message);

const notFound = () =>
  receptionProblem(HttpStatus.NOT_FOUND, 'not_found', 'Received document not found');

function parseId(raw: string): string {
  if (!UUID.test(raw)) throw invalidRequest('Received document id must be a UUID');
  return raw;
}

function asBadRequest(error: unknown): unknown {
  return error instanceof InvalidReceivedDocumentQueryError ? invalidRequest(error.message) : error;
}

/** ASCII-only, quote-free file name for `Content-Disposition`; never the storage key. */
function downloadName(originalName: string | null, id: string, contentType: string): string {
  const cleaned = (originalName ?? '').replace(/[^\x20-\x7e]|["\\;]/g, '_').trim();
  if (cleaned !== '') return cleaned;
  return `received-${id}${contentType.includes('xml') ? '.xml' : ''}`;
}

function notXml() {
  return receptionProblem(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    'unsupported_media_type',
    'The upload is not an XML document',
  );
}

function unsupportedSource() {
  return receptionProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'unsupported_source',
    'Only SIFEN XML documents are supported for now',
  );
}

/** Minimal acknowledgement; the document shape (fiscal data) belongs to the GET endpoints. */
function present(document: ReceivedDocument) {
  return {
    id: document.id,
    status: document.status,
    version: document.version,
    source: document.source,
  };
}
