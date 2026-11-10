import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  NotImplementedException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ExcludeFromOpenApi } from '../../../api-docs/infrastructure/exclude-from-openapi.decorator.js';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import type { IngestSifenXml } from '../../application/ingest-sifen-xml.js';
import type { ReceivedDocument } from '../../domain/received-document.js';
import { INGEST_SIFEN_XML, RECEPTION_UPLOAD_CONFIG } from '../../reception.tokens.js';
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
 * Reception API. `POST` stores a SIFEN XML (reception R4.2); the list route is still a skeleton
 * (R4.3). Scopes: `reception:write` uploads, corrects, confirms and reprocesses; `reception:read`
 * reads.
 */
@Controller('v1/received-documents')
export class ReceivedDocumentsController {
  constructor(
    @Inject(INGEST_SIFEN_XML) private readonly ingest: IngestSifenXml | null,
    @Inject(RECEPTION_UPLOAD_CONFIG) private readonly config: ReceptionUploadConfig,
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

  @ExcludeFromOpenApi()
  @Get()
  @RequireScopes('reception:read')
  list(): never {
    throw new NotImplementedException('not_implemented');
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
