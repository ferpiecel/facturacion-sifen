// Fixture: violates `application-no-infrastructure` — application must not import infrastructure.
import { InfrastructureTarget } from '../infrastructure/target.js';

export class ApplicationImportsInfrastructureFixture {
  constructor(private readonly target: InfrastructureTarget) {}
}
