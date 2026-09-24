import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { Public } from '../../../identity/infrastructure/decorators/public.decorator.js';
import { GetHealthUseCase } from '../../application/get-health.use-case.js';

@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly getHealthUseCase: GetHealthUseCase) {}

  @Get()
  async getHealth() {
    const report = await this.getHealthUseCase.execute();

    if (report.status === 'down') {
      throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return report;
  }
}
