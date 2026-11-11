import { Module } from '@nestjs/common';
import { loadGeoCatalog } from '@sifen/sifen-xsd';
import { createGeoCatalog } from './domain/geo-catalog.js';
import { GEO_CATALOG } from './geo.tokens.js';
import { GeoController } from './infrastructure/http/geo.controller.js';

/** Read endpoints over the vendored DNIT geographic table (ADR-0017). */
@Module({
  controllers: [GeoController],
  providers: [{ provide: GEO_CATALOG, useFactory: () => createGeoCatalog(loadGeoCatalog()) }],
})
export class GeoModule {}
