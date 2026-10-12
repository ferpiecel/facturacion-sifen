import { describe, expect, it } from 'vitest';
import { InvalidListQueryError, parseListQuery } from './list-query.js';

describe('parseListQuery (HU-E12-01)', () => {
  it('applies the defaults', () => {
    expect(parseListQuery({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('maps the type code, keeps a valid status and the Asuncion day range', () => {
    expect(
      parseListQuery({
        type: 'NCE',
        status: 'approved',
        from: '2026-01-31',
        to: '2026-02-01',
        q: ' 0000123 ',
        page: '2',
        pageSize: '100',
      }),
    ).toEqual({
      documentType: 5,
      status: 'approved',
      from: '2026-01-31',
      to: '2026-02-01',
      q: '0000123',
      page: 2,
      pageSize: 100,
    });
  });

  it.each([
    ['type', 'XX'],
    ['status', 'bogus'],
    ['from', '2026-02-30'],
    ['from', '01/02/2026'],
    ['to', 'tomorrow'],
    ['page', '0'],
    ['page', '1.5'],
    ['pageSize', '101'],
    ['pageSize', '0'],
    ['q', 'x'.repeat(101)],
    ['status', ['approved', 'rejected']],
  ])('rejects %s=%j', (name, value) => {
    expect(() => parseListQuery({ [name]: value })).toThrow(InvalidListQueryError);
  });

  it('rejects an inverted date range', () => {
    expect(() => parseListQuery({ from: '2026-03-01', to: '2026-02-01' })).toThrow(
      InvalidListQueryError,
    );
  });
});
