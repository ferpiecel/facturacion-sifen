import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ReceptionModule } from './reception.module.js';

describe('ReceptionModule', () => {
  it('boots with only the HTTP skeleton controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ReceptionModule] }).compile();

    expect(moduleRef.get(ReceptionModule)).toBeInstanceOf(ReceptionModule);
    await moduleRef.close();
  });
});
