import { Module } from '@nestjs/common';
import { GuideBrowser } from './application/guide-browser.js';
import {
  API_DOCS_ENABLED,
  GUIDE_BROWSER,
  isApiDocsEnabled,
  resolveGuidesRoot,
} from './infrastructure/api-docs-config.js';
import { ApiDocsController } from './infrastructure/controllers/api-docs.controller.js';
import { GuidesController } from './infrastructure/controllers/guides.controller.js';
import { FsGuideCatalog } from './infrastructure/fs-guide-catalog.adapter.js';
import { MarkdownItRenderer } from './infrastructure/markdown-it-renderer.adapter.js';

@Module({
  controllers: [ApiDocsController, GuidesController],
  providers: [
    { provide: API_DOCS_ENABLED, useFactory: () => isApiDocsEnabled(process.env) },
    {
      provide: GUIDE_BROWSER,
      // Only scan the disk when the docs are on; otherwise the allowlist stays empty.
      useFactory: () =>
        new GuideBrowser(
          new FsGuideCatalog(
            isApiDocsEnabled(process.env)
              ? resolveGuidesRoot(process.env, process.cwd())
              : undefined,
          ),
          new MarkdownItRenderer(),
        ),
    },
  ],
})
export class ApiDocsModule {}
