import { SetMetadata } from '@nestjs/common';

export const EXCLUDED_FROM_OPENAPI_KEY = 'excludedFromOpenApi';

/**
 * Marks an integrator controller, or a single handler, as not yet part of the hand-written OpenAPI
 * spec (for example a skeleton whose contract is still pending). The spec-sync test skips it;
 * remove the marker when the route is documented in `openapi.ts`.
 */
export const ExcludeFromOpenApi = (): ClassDecorator & MethodDecorator =>
  SetMetadata(EXCLUDED_FROM_OPENAPI_KEY, true);
