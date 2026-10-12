import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../identity/infrastructure/decorators/public.decorator.js';
import { RequireActiveTenant } from '../../identity/infrastructure/http/require-active-tenant.decorator.js';
import {
  CurrentSession,
  SessionGuard,
  type PortalSession,
} from '../../identity/infrastructure/http/session.guard.js';
import type { createGetPortalSummary } from '../application/get-portal-summary.js';
import { InvalidSummaryQueryError } from '../domain/summary-period.js';
import { GET_PORTAL_SUMMARY } from '../portal-documents.tokens.js';

/**
 * HU-E12-03: the period summary of the active tenant's documents. Same guards as the documents controller:
 * the tenant is the session's active one and every role may read.
 */
@Public()
@Controller('portal/summary')
@UseGuards(SessionGuard)
@RequireActiveTenant()
export class PortalSummaryController {
  constructor(
    @Inject(GET_PORTAL_SUMMARY)
    private readonly getSummary: ReturnType<typeof createGetPortalSummary>,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async summary(@Query() query: Record<string, unknown>, @CurrentSession() session: PortalSession) {
    try {
      return await this.getSummary(session.activeTenant?.tenantId ?? '', query);
    } catch (error) {
      if (error instanceof InvalidSummaryQueryError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
