import { Controller, Get, Inject, NotFoundException, Query } from '@nestjs/common';
import type { GeoCatalog } from '../../domain/geo-catalog.js';
import { GEO_CATALOG } from '../../geo.tokens.js';
import { parseCodeQuery } from './geo-query.js';

/**
 * HU-E5-08 / ADR-0017. Public reference data behind the API key guard, with no extra scope. Lists
 * are filtered by parent: no endpoint returns the full city table.
 */
@Controller('v1/geo')
export class GeoController {
  constructor(@Inject(GEO_CATALOG) private readonly catalog: GeoCatalog) {}

  @Get('departments')
  departments() {
    return { items: this.catalog.departments().map(({ code, name }) => ({ code, name })) };
  }

  @Get('districts')
  districts(@Query('departmentCode') raw: unknown) {
    const code = parseCodeQuery('departmentCode', raw);
    const found = this.catalog.districtsOf(code);
    if (!found) throw new NotFoundException('Department not found');
    return {
      items: found.map(({ code, departmentCode, name }) => ({ code, departmentCode, name })),
    };
  }

  @Get('cities')
  cities(@Query('districtCode') raw: unknown) {
    const code = parseCodeQuery('districtCode', raw);
    const found = this.catalog.citiesOf(code);
    if (!found) throw new NotFoundException('District not found');
    return { items: found.map(({ code, districtCode, name }) => ({ code, districtCode, name })) };
  }
}
