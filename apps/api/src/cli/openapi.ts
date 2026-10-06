import { buildOpenApiDocument } from '../modules/api-docs/infrastructure/openapi.js';

/** Prints the OpenAPI document: `pnpm --filter @sifen/api openapi > docs/api/openapi.json`. */
process.stdout.write(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
