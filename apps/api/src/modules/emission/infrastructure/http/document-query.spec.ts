import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parseCdcQuery, parseDocumentId } from './document-query.js';

const UUID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';

function statusOf(call: () => unknown): number | undefined {
  try {
    call();
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : undefined;
  }
  return undefined;
}

/** Spec: HU-E5-07. Malformed identifiers are 400 before touching the database. */
describe('document query parsing', () => {
  it('accepts a UUID document id and a 44-digit CDC', () => {
    expect(parseDocumentId(UUID)).toBe(UUID);
    expect(parseCdcQuery('1'.repeat(44))).toBe('1'.repeat(44));
  });

  it.each(['abc', '', '3f2b8c1e', `${UUID}0`])('rejects the document id %j with 400', (raw) => {
    expect(statusOf(() => parseDocumentId(raw))).toBe(400);
  });

  it.each([undefined, '', '1'.repeat(43), '1'.repeat(45), `${'1'.repeat(43)}x`, ['1'.repeat(44)]])(
    'rejects the cdc %j with 400',
    (raw) => {
      expect(statusOf(() => parseCdcQuery(raw))).toBe(400);
    },
  );
});
