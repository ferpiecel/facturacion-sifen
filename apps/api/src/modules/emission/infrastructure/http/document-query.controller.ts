import {
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';
import {
  TENANT_ID_CLS_KEY,
  type TenancyClsStore,
} from '../../../tenancy/infrastructure/tenancy-cls-store.js';
import type { createGetDocument } from '../../application/get-document.js';
import type { createGetKude } from '../../application/get-kude.js';
import { KudeSourceError } from '../../application/kude-reader.js';
import { GET_DOCUMENT, GET_KUDE } from '../../emission.tokens.js';
import { parseCdcQuery, parseDocumentId } from './document-query.js';

/** HU-E5-07. The tenant comes from the API key; another tenant's document is a 404. */
@Controller('v1/documents')
@RequireScopes('documents:read')
export class DocumentQueryController {
  private readonly logger = new Logger(DocumentQueryController.name);

  constructor(
    @Inject(GET_DOCUMENT) private readonly getDocument: ReturnType<typeof createGetDocument>,
    @Inject(GET_KUDE) private readonly getKude: ReturnType<typeof createGetKude>,
    private readonly cls: ClsService<TenancyClsStore>,
  ) {}

  @Get(':id')
  byId(@Param('id') id: string) {
    return this.find({ id: parseDocumentId(id) });
  }

  /** HU-E10-01: the KuDE PDF, available as soon as the document is signed. */
  @Get(':id/kude')
  @Header('Cache-Control', 'private, no-store')
  async kude(@Param('id') id: string) {
    const documentId = parseDocumentId(id);
    const result = await this.getKude(this.cls.get(TENANT_ID_CLS_KEY), documentId).catch(
      (error: unknown) => {
        if (!(error instanceof KudeSourceError)) throw error;
        // Field name only: neither the XML nor its values reach the log or the response.
        this.logger.error(`KuDE not printable for document ${documentId}: ${error.field}`);
        throw new InternalServerErrorException('The KuDE could not be generated');
      },
    );
    if (result.kind === 'not-found') throw new NotFoundException('Document not found');
    if (result.kind === 'not-signed') throw new ConflictException('Document is not signed yet');
    return new StreamableFile(result.pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${result.filename}"`,
    });
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
