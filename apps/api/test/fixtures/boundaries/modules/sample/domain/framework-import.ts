// Fixture: violates `domain-app-framework-free` — domain/application must stay framework-free.
import { Injectable } from '@nestjs/common';

@Injectable()
export class FrameworkImportFixture {}
