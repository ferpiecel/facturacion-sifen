import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { Public } from '../../identity/infrastructure/decorators/public.decorator.js';
import { RequireActiveTenant } from '../../identity/infrastructure/http/require-active-tenant.decorator.js';
import {
  CurrentSession,
  SessionGuard,
  type PortalSession,
} from '../../identity/infrastructure/http/session.guard.js';
import type { createListAttentionDocuments } from '../application/list-attention-documents.js';
import { LIST_ATTENTION_DOCUMENTS } from '../portal-documents.tokens.js';

/**
 * HU-E12-04: the documents of the active tenant that need the user's action. Same guards as the documents
 * controller: the tenant is the session's active one and every role may read.
 */
@Public()
@Controller('portal/attention')
@UseGuards(SessionGuard)
@RequireActiveTenant()
export class PortalAttentionController {
  constructor(
    @Inject(LIST_ATTENTION_DOCUMENTS)
    private readonly listAttention: ReturnType<typeof createListAttentionDocuments>,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentSession() session: PortalSession) {
    return this.listAttention(session.activeTenant?.tenantId ?? '');
  }
}
