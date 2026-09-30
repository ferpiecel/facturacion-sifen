import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  it('joins truthy class names and drops falsy ones', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b');
  });

  it('lets the last conflicting Tailwind utility win', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });

  it('keeps a Stitch font size alongside a text color', () => {
    expect(cn('text-headline-md text-on-surface', 'text-error')).toBe(
      'text-headline-md text-error',
    );
  });

  it('treats Stitch type-scale sizes and families as conflicting with each other', () => {
    expect(cn('font-label-sm text-label-sm', 'font-code-sm text-code-sm')).toBe(
      'font-code-sm text-code-sm',
    );
  });
});
