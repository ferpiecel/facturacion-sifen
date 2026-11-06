import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ReceptionModule } from './reception.module.js';

describe('ReceptionModule', () => {
  it('boots empty without any provider or controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ReceptionModule] }).compile();

    expect(moduleRef.get(ReceptionModule)).toBeInstanceOf(ReceptionModule);
    await moduleRef.close();
  });
});
