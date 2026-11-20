import {
  Body,
  Controller,
  Get,
  Header,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  API_KEY_ID_CLS_KEY,
  type IdentityClsStore,
} from '../../../identity/infrastructure/identity-cls-store.js';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import {
  InvalidCorrectionError,
  InvalidReceivedDocumentStateError,
  ValidationFailedError,
  type createCorrectReceivedDocument,
} from '../../application/correct-received-document.js';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
} from '../../application/ports/received-document-repository.port.js';
import {
  ArtifactNotAvailableError,
  ReprocessNotAllowedError,
  type createReprocessReceivedDocument,
} from '../../application/reprocess-received-document.js';
import { ReceptionQueueUnavailableError } from '../../application/ports/reception-job-queue.port.js';
import { StorageUnavailableError } from '../../application/ports/storage-provider.port.js';
import { ExtractionQuotaExceededError } from '../../application/extraction-quota.js';
import type { createGetArtifact, createGetArtifactUrl } from '../../application/get-artifact.js';
import type { createGetReceivedDocument } from '../../application/get-received-document.js';
import type { IngestUpload } from '../../application/ingest-upload.js';
import {
  InvalidReceivedDocumentQueryError,
  type createListReceivedDocuments,
} from '../../application/list-received-documents.js';
import type { ReceivedDocument } from '../../domain/received-document.js';
import {
  CORRECT_RECEIVED_DOCUMENT,
  GET_RECEIVED_DOCUMENT,
  GET_RECEPTION_ARTIFACT,
  GET_RECEPTION_ARTIFACT_URL,
  INGEST_UPLOAD,
  LIST_RECEIVED_DOCUMENTS,
  RECEPTION_UPLOAD_CONFIG,
  REPROCESS_RECEIVED_DOCUMENT,
} from '../../reception.tokens.js';
import { sniffUpload } from '../../domain/upload-sniff.js';
import { parseCorrectionRequest } from './correct-received-document.request.js';
import {
  presentReceivedDocumentDetail,
  presentReceivedDocumentPage,
} from './received-document.presenter.js';
import { receptionProblem } from './reception-http-errors.js';
import type { ReceptionUploadConfig } from './reception-upload-config.js';

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
    @Inject(INGEST_UPLOAD) private readonly ingest: IngestUpload | null,
    @Inject(RECEPTION_UPLOAD_CONFIG) private readonly config: ReceptionUploadConfig,
    @Inject(LIST_RECEIVED_DOCUMENTS)
    private readonly listDocuments: ReturnType<typeof createListReceivedDocuments> | null,
    @Inject(GET_RECEIVED_DOCUMENT)
    private readonly getDocument: ReturnType<typeof createGetReceivedDocument> | null,
    @Inject(GET_RECEPTION_ARTIFACT)
    private readonly getArtifact: ReturnType<typeof createGetArtifact> | null,
    @Inject(GET_RECEPTION_ARTIFACT_URL)
    private readonly getArtifactUrl: ReturnType<typeof createGetArtifactUrl> | null,
    @Inject(CORRECT_RECEIVED_DOCUMENT)
    private readonly correctDocument: ReturnType<typeof createCorrectReceivedDocument> | null,
    @Inject(REPROCESS_RECEIVED_DOCUMENT)
    private readonly reprocessDocument: ReturnType<typeof createReprocessReceivedDocument> | null,
    private readonly cls: ClsService<TenancyClsStore & IdentityClsStore>,
  ) {}

  /**
   * Accepts an upload (raw bytes, multipart `file` or JSON `{ xml }`). The bytes decide the kind:
   * SIFEN XML is processed synchronously (202 new / 200 duplicate, 422 `extraction_failed` when it
   * is unreadable); PDF, PNG and JPEG are stored and queued for asynchronous extraction (202 with
   * `Location`, status `received`; 200 when the same bytes were uploaded before; 503
   * `queue_unavailable` when the job could not be queued, the upload is kept and re-uploading the
   * same bytes queues it again; 429 `extraction_quota_exceeded` with `Retry-After` when the tenant
   * used its daily extraction cap). A bare CDC and any other bytes answer 422 `unsupported_source`
   * or 415 `unsupported_media_type`.
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
    if (sniffUpload(upload.bytes) === 'unknown') throw notSupportedMedia();

    const result = await this.ingest.execute({
      tenantId: this.cls.get(TENANT_ID_CLS_KEY),
      bytes: upload.bytes,
      originalName: upload.originalName,
    });
    // Reception events were enqueued by the repository, in the document's own transaction (R4.5).
    switch (result.kind) {
      case 'unsupported_source':
        throw unsupportedSource();
      case 'queue_unavailable':
        throw receptionProblem(
          HttpStatus.SERVICE_UNAVAILABLE,
          'queue_unavailable',
          'The extraction queue is not available; the upload was kept, retry the same upload later',
          { document_id: result.document.id },
        );
      case 'quota_exceeded':
        throw quotaProblem(reply, result.cap, result.retryAfterSeconds);
      case 'accepted':
        return accepted(reply, HttpStatus.ACCEPTED, result.document);
      case 'duplicate':
        return accepted(reply, HttpStatus.OK, result.document);
      case 'xml': {
        const { document } = result.result;
        if (document.status === 'extraction_failed') {
          throw receptionProblem(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'extraction_failed',
            'The XML could not be read as a supported SIFEN document',
            { document_id: document.id },
          );
        }
        return accepted(
          reply,
          result.result.created ? HttpStatus.ACCEPTED : HttpStatus.OK,
          document,
        );
      }
    }
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

  /**
   * Corrects header fields and items and optionally confirms, in one call. The body carries the
   * `version` the caller read (optimistic lock; there is no `If-Match`). 200 with the detail
   * shape; a replay of an already applied request is a 200 too (`Idempotent-Replayed: true`).
   * Errors: 400 `invalid_request`, 404 `not_found`, 409 `version_conflict` (with
   * `current_version`) or `invalid_state`, 422 `validation_failed` (with `reasons`; nothing is
   * written) or `invalid_correction`.
   */
  @Patch(':id')
  @RequireScopes('reception:write')
  async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: HttpReply,
  ) {
    const correct = this.require(this.correctDocument);
    const documentId = parseId(id);
    const parsed = parseCorrectionRequest(body);
    if (!parsed.ok) {
      throw receptionProblem(
        HttpStatus.BAD_REQUEST,
        'invalid_request',
        'The request body is not valid',
        { issues: parsed.issues },
      );
    }
    const tenantId = this.tenantId();
    try {
      const result = await correct({
        ...parsed.value,
        tenantId,
        id: documentId,
        actorId: this.cls.get(API_KEY_ID_CLS_KEY),
      });
      // The `updated` / `confirmed` event was enqueued in the correction's transaction (R4.5).
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      const detail = await this.require(this.getDocument)(tenantId, documentId);
      if (detail === null) throw notFound();
      return presentReceivedDocumentDetail(detail);
    } catch (error) {
      throw asCorrectionProblem(error);
    }
  }

  /**
   * Re-runs the extraction on the STORED artifact. PDF and photo: 202 with `Location`, the job is
   * queued (a second request while one is queued or running is a no-op 202). SIFEN XML that was
   * unreadable: re-read synchronously, 200 with the new status (422 `extraction_failed` when it is
   * still unreadable). Errors: 404 `not_found`, 409 `artifact_not_available` or `invalid_state`
   * (with `status`), 429 `extraction_quota_exceeded` (with `Retry-After`) past the daily cap, 503 `queue_unavailable`
   * or `storage_unavailable` (any storage failure).
   */
  @Post(':id/reprocess')
  @RequireScopes('reception:write')
  async reprocess(@Param('id') id: string, @Res({ passthrough: true }) reply: HttpReply) {
    const reprocess = this.requireStorage(this.reprocessDocument);
    try {
      const result = await reprocess({
        tenantId: this.tenantId(),
        id: parseId(id),
        actor: { type: 'api_key', id: this.cls.get(API_KEY_ID_CLS_KEY) },
      });
      if (result.kind === 'failed') {
        throw receptionProblem(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'extraction_failed',
          'The XML could not be read as a supported SIFEN document',
          { document_id: result.document.id },
        );
      }
      const status = result.kind === 'reprocessed' ? HttpStatus.OK : HttpStatus.ACCEPTED;
      return accepted(reply, status, result.document);
    } catch (error) {
      if (error instanceof ExtractionQuotaExceededError) {
        throw quotaProblem(reply, error.cap, error.retryAfterSeconds);
      }
      throw asReprocessProblem(error);
    }
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
    if (!Buffer.isBuffer(body)) throw notSupportedMedia();
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

export const notFound = () =>
  receptionProblem(HttpStatus.NOT_FOUND, 'not_found', 'Received document not found');

export function parseId(raw: string): string {
  if (!UUID.test(raw)) throw invalidRequest('Received document id must be a UUID');
  return raw;
}

export function asBadRequest(error: unknown): unknown {
  return error instanceof InvalidReceivedDocumentQueryError ? invalidRequest(error.message) : error;
}

function asCorrectionProblem(error: unknown): unknown {
  if (error instanceof ReceivedDocumentNotFoundError) return notFound();
  if (error instanceof VersionConflictError) {
    return receptionProblem(
      HttpStatus.CONFLICT,
      'version_conflict',
      'The document changed since the version you read',
      { current_version: error.currentVersion ?? null },
    );
  }
  if (error instanceof InvalidReceivedDocumentStateError) {
    return receptionProblem(
      HttpStatus.CONFLICT,
      'invalid_state',
      'The document cannot be corrected in its current status',
      { status: error.status },
    );
  }
  if (error instanceof ValidationFailedError) {
    return receptionProblem(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'validation_failed',
      'The corrected document does not pass validation; nothing was saved',
      { reasons: error.reasons },
    );
  }
  if (error instanceof InvalidCorrectionError) {
    return receptionProblem(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_correction', error.message);
  }
  return error;
}

/** 429 with `Retry-After` until the next UTC day, when the cap counts again. */
function quotaProblem(reply: HttpReply, cap: number, retryAfterSeconds: number): unknown {
  reply.header('retry-after', String(retryAfterSeconds));
  return receptionProblem(
    HttpStatus.TOO_MANY_REQUESTS,
    'extraction_quota_exceeded',
    'The daily extraction quota of the tenant is exhausted; try again after the next UTC day starts',
    { cap, retry_after_seconds: retryAfterSeconds },
  );
}

function asReprocessProblem(error: unknown): unknown {
  if (error instanceof ReceivedDocumentNotFoundError) return notFound();
  if (error instanceof ArtifactNotAvailableError) {
    return receptionProblem(
      HttpStatus.CONFLICT,
      'artifact_not_available',
      'The document has no stored artifact to reprocess',
    );
  }
  if (error instanceof ReprocessNotAllowedError) {
    return receptionProblem(
      HttpStatus.CONFLICT,
      'invalid_state',
      'The document cannot be reprocessed in its current status',
      { status: error.status },
    );
  }
  if (error instanceof ReceptionQueueUnavailableError) {
    return receptionProblem(
      HttpStatus.SERVICE_UNAVAILABLE,
      'queue_unavailable',
      'The extraction queue is not available; try again later',
    );
  }
  if (error instanceof StorageUnavailableError) {
    return receptionProblem(
      HttpStatus.SERVICE_UNAVAILABLE,
      'storage_unavailable',
      'Document storage is not available',
    );
  }
  return error;
}

/** ASCII-only, quote-free file name for `Content-Disposition`; never the storage key. */
function downloadName(originalName: string | null, id: string, contentType: string): string {
  const cleaned = (originalName ?? '').replace(/[^\x20-\x7e]|["\\;]/g, '_').trim();
  if (cleaned !== '') return cleaned;
  return `received-${id}${contentType.includes('xml') ? '.xml' : ''}`;
}

function notSupportedMedia() {
  return receptionProblem(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    'unsupported_media_type',
    'The upload is not a SIFEN XML, a PDF or a PNG/JPEG image',
  );
}

function unsupportedSource() {
  return receptionProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'unsupported_source',
    'Only SIFEN XML, PDF and PNG/JPEG uploads are supported for now (a bare CDC is not)',
  );
}

function accepted(reply: HttpReply, status: HttpStatus, document: ReceivedDocument) {
  reply.status(status);
  reply.header('location', `/v1/received-documents/${document.id}`);
  return present(document);
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
