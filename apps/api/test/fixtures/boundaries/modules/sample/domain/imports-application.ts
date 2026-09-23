// Fixture: violates `domain-no-outer-layers` — domain must not import application/infrastructure.
import { ApplicationTarget } from '../application/target.js';

export class DomainImportsApplicationFixture {
  constructor(private readonly target: ApplicationTarget) {}
}
