import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ACTIVE_TENANT_KEY = 'requireActiveTenant';

/** The route needs a selected tenant the user STILL belongs to; the `SessionGuard` answers 403 otherwise. */
export const RequireActiveTenant = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_ACTIVE_TENANT_KEY, true);
