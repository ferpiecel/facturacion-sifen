import { Controller, Get, Inject, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { Public } from '../../identity/infrastructure/decorators/public.decorator.js';
import {
  CurrentSession,
  SessionGuard,
  type PortalSession,
} from '../../identity/infrastructure/http/session.guard.js';
import type { GetPartnerStatusUseCase } from '../application/get-partner-status.use-case.js';
import { GET_PARTNER_STATUS } from '../partners.tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HU-E1-06: the partner's operational view of its tenants, for a verified portal session. `@Public()` only opts
 * out of the API-key guard (a browser has no key); the {@link SessionGuard} protects the route. A partner the user
 * does not belong to answers 404, the same as an unknown one.
 */
@Public()
@Controller('partners')
export class PartnerStatusController {
  constructor(@Inject(GET_PARTNER_STATUS) private readonly status: GetPartnerStatusUseCase) {}

  @Get(':partnerId/tenants/status')
  @UseGuards(SessionGuard)
  async tenantsStatus(
    @Param('partnerId') partnerId: string,
    @CurrentSession() session: PortalSession,
  ) {
    const tenants = UUID.test(partnerId)
      ? await this.status.execute(session.userId, partnerId)
      : null;
    if (!tenants) throw new NotFoundException('Partner not found');
    return { partnerId, tenants };
  }
}
