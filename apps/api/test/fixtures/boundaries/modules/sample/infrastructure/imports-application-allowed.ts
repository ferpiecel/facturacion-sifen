// Fixture: allowed direction — infrastructure may import from application.
import { ApplicationTarget } from '../application/target.js';

export class InfrastructureImportsApplicationFixture {
  constructor(private readonly target: ApplicationTarget) {}
}
