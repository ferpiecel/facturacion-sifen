import { describe, expect, it } from 'vitest';
import { InvalidTenantIdError } from '../src/errors.js';
import { assertValidTenantId, isValidTenantId } from '../src/tenant-id.js';

describe('tenant id validation', () => {
  it('accepts a well-formed UUID', () => {
    expect(isValidTenantId('9c858f84-3e3d-4d4b-9c0a-9c9f0a0a0a0a')).toBe(true);
    expect(() => {
      assertValidTenantId('9c858f84-3e3d-4d4b-9c0a-9c9f0a0a0a0a');
    }).not.toThrow();
  });

  it.each([
    ['empty string', ''],
    ['not a uuid', 'not-a-uuid'],
    ['sql injection payload', "'; DROP TABLE tenant_probe; --"],
    ['numeric', 12345],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s before it reaches SQL', (_label, value) => {
    expect(isValidTenantId(value)).toBe(false);
    expect(() => {
      assertValidTenantId(value);
    }).toThrow(InvalidTenantIdError);
  });
});
