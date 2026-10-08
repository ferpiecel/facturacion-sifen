import { Module } from '@nestjs/common';
import { API_DOCS_ENABLED, isApiDocsEnabled } from './infrastructure/api-docs-config.js';
import { ApiDocsController } from './infrastructure/controllers/api-docs.controller.js';

@Module({
  controllers: [ApiDocsController],
  providers: [{ provide: API_DOCS_ENABLED, useFactory: () => isApiDocsEnabled(process.env) }],
})
export class ApiDocsModule {}
