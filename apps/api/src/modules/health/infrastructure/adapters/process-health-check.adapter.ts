import { Injectable } from '@nestjs/common';
import type { HealthCheckPort } from '../../application/ports/health-check.port.js';

@Injectable()
export class ProcessHealthCheckAdapter implements HealthCheckPort {
  check(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
