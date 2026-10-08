import { Controller, Get, Header, Inject, NotFoundException } from '@nestjs/common';
import { Public } from '../../../identity/infrastructure/decorators/public.decorator.js';
import { API_DOCS_ENABLED } from '../api-docs-config.js';
import { buildOpenApiDocument } from '../openapi.js';
import { REDOC_CONTENT_SECURITY_POLICY, REDOC_PAGE } from '../redoc-page.js';

/**
 * Human-browsable integrator API docs. `@Public()` (no API key) but gated by environment: when
 * disabled both routes answer 404. Not in the OpenAPI document itself (the drift test skips `@Public`).
 */
@Controller('docs')
@Public()
export class ApiDocsController {
  constructor(@Inject(API_DOCS_ENABLED) private readonly enabled: boolean) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', REDOC_CONTENT_SECURITY_POLICY)
  viewer(): string {
    this.assertEnabled();
    return REDOC_PAGE;
  }

  @Get('openapi.json')
  spec() {
    this.assertEnabled();
    return buildOpenApiDocument();
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }
}
