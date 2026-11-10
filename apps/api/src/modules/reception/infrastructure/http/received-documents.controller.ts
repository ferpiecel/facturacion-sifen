import { Controller, Get, NotImplementedException, Post } from '@nestjs/common';
import { ExcludeFromOpenApi } from '../../../api-docs/infrastructure/exclude-from-openapi.decorator.js';
import { RequireScopes } from '../../../identity/infrastructure/decorators/require-scopes.decorator.js';

/**
 * Reception API skeleton (reception R4.1): proves the API-key scope guard only.
 * Request and response contracts land with R4.2 (upload) and R4.3 (list, get, artifact).
 * Scopes: `reception:write` uploads, corrects, confirms and reprocesses; `reception:read` reads.
 * Excluded from the hand-written OpenAPI spec until R4.2/R4.3 document the real contracts.
 */
@ExcludeFromOpenApi()
@Controller('v1/received-documents')
export class ReceivedDocumentsController {
  @Post()
  @RequireScopes('reception:write')
  upload(): never {
    throw new NotImplementedException('not_implemented');
  }

  @Get()
  @RequireScopes('reception:read')
  list(): never {
    throw new NotImplementedException('not_implemented');
  }
}
