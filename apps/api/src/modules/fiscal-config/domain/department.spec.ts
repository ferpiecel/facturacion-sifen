import { describe, expect, it } from 'vitest';
import { DEPARTMENTS, getDepartmentDescription, InvalidDepartmentCodeError } from './department.js';

describe('getDepartmentDescription', () => {
  it('resolves the description for a known department code (CAPITAL)', () => {
    expect(getDepartmentDescription(1)).toBe('CAPITAL');
  });

  it('resolves the description for the last known department code (NUEVA ASUNCION)', () => {
    expect(getDepartmentDescription(20)).toBe('NUEVA ASUNCION');
  });

  it('rejects a code outside the closed table (0)', () => {
    expect(() => getDepartmentDescription(0)).toThrow(InvalidDepartmentCodeError);
  });

  it('rejects a code outside the closed table (21)', () => {
    expect(() => getDepartmentDescription(21)).toThrow(InvalidDepartmentCodeError);
  });

  it('exposes exactly the 20 departments from the vendored XSD', () => {
    expect(Object.keys(DEPARTMENTS)).toHaveLength(20);
  });
});
