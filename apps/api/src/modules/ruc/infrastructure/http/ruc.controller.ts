import {
  BadGatewayException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
} from '@nestjs/common';
import type { createLookupRuc } from '../../application/lookup-ruc.js';
import { RucLookupDeniedError, RucLookupFailedError } from '../../application/lookup-ruc.js';
import { LOOKUP_RUC } from '../../ruc.tokens.js';

const RUC_PARAM = /^\d{5,8}$/;

/**
 * HU-E6-09. Looks a RUC up in the SIFEN registry (through the cache) so integrators can validate a receiver.
 * Any valid API key works, no scope. Responses never carry SIFEN's raw message or code.
 */
@Controller('v1/ruc')
export class RucController {
  constructor(@Inject(LOOKUP_RUC) private readonly lookup: ReturnType<typeof createLookupRuc>) {}

  @Get(':ruc')
  async find(@Param('ruc') ruc: string) {
    if (!RUC_PARAM.test(ruc)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'The RUC must have 5 to 8 digits, without the check digit',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      const result = await this.lookup(ruc);
      if (!result.found || result.contribuyente === null)
        throw new NotFoundException('RUC not found');
      return {
        ruc,
        cached: result.cached,
        taxpayer: {
          legal_name: result.contribuyente.razonSocial,
          status: result.contribuyente.estado,
          electronic_invoicer: result.contribuyente.facturadorElectronico,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof RucLookupDeniedError || error instanceof RucLookupFailedError) {
        throw new BadGatewayException('The RUC registry could not be queried');
      }
      throw new BadGatewayException('The RUC registry is unreachable');
    }
  }
}
