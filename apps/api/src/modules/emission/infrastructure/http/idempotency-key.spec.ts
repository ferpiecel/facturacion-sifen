import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parseIdempotencyKey } from './idempotency-key.js';

/** Spec: HU-E5-02 (RF-03). The `Idempotency-Key` header is required: 1 to 255 printable ASCII characters. */
describe('parseIdempotencyKey', () => {
  it('returns a valid key as is', () => {
    expect(parseIdempotencyKey('order-2026/03:7_a.b~c')).toBe('order-2026/03:7_a.b~c');
    expect(parseIdempotencyKey('k'.repeat(255))).toHaveLength(255);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'k'.repeat(256)],
    ['with a space', 'a b'],
    ['non-ASCII', 'clavé'],
    ['with a control character', 'a\u0001b'],
    ['repeated header', ['a', 'b'] as unknown as string],
  ])('rejects a key that is %s with 400', (_label, value) => {
    let thrown: unknown;
    try {
      parseIdempotencyKey(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(400);
    expect((thrown as HttpException).getResponse()).toMatchObject({
      message: expect.stringContaining('Idempotency-Key') as string,
    });
  });
});
