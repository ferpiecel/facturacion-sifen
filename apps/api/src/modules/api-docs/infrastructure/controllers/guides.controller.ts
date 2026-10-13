import { Controller, Get, Header, Inject, NotFoundException, Param } from '@nestjs/common';
import type { GuideBrowser } from '../../application/guide-browser.js';
import { Public } from '../../../identity/infrastructure/decorators/public.decorator.js';
import { API_DOCS_ENABLED, GUIDE_BROWSER } from '../api-docs-config.js';
import {
  GUIDES_CONTENT_SECURITY_POLICY,
  renderGuidePage,
  renderGuidesIndex,
} from '../guides-page.js';

/**
 * Markdown guides under `/docs/guides`, behind the same gate as `/docs`. Pages are looked up by
 * exact key in the startup allowlist; the request path never reaches the filesystem.
 */
@Controller('docs/guides')
@Public()
export class GuidesController {
  constructor(
    @Inject(API_DOCS_ENABLED) private readonly enabled: boolean,
    @Inject(GUIDE_BROWSER) private readonly guides: GuideBrowser,
  ) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', GUIDES_CONTENT_SECURITY_POLICY)
  index(): string {
    this.assertEnabled();
    return renderGuidesIndex(this.guides.index());
  }

  @Get('*')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', GUIDES_CONTENT_SECURITY_POLICY)
  page(@Param('*') path: string | string[]): string {
    this.assertEnabled();
    const key = Array.isArray(path) ? path.join('/') : path;
    const page = this.guides.page(key);
    if (!page) throw new NotFoundException();
    return renderGuidePage(page.title, page.html);
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }
}
