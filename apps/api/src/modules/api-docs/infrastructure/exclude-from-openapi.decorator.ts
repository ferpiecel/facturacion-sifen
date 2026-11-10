import { SetMetadata } from '@nestjs/common';

export const EXCLUDED_FROM_OPENAPI_KEY = 'excludedFromOpenApi';

/**
 * Marks an integrator controller as not yet part of the hand-written OpenAPI spec (for example a
 * skeleton whose contract is still pending). The spec-sync test skips it; remove the marker when
 * the routes are documented in `openapi.ts`.
 */
export const ExcludeFromOpenApi = (): ClassDecorator =>
  SetMetadata(EXCLUDED_FROM_OPENAPI_KEY, true);
