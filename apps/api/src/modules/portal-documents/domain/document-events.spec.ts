import { describe, expect, it } from 'vitest';
import { buildDocumentEvents, rejectionReasonOf } from './document-events.js';

const created = new Date('2026-01-01T10:00:00Z');
const signed = new Date('2026-01-01T10:00:05Z');
const updated = new Date('2026-01-01T10:05:00Z');
const REJECTION = [{ code: '1321', message: 'Receptor innominado no permitido' }];
const input = (over: Partial<Parameters<typeof buildDocumentEvents>[0]>) => ({
  status: 'accepted',
  createdAt: created,
  signedAt: null,
  updatedAt: created,
  messages: [],
  ...over,
});
const event = (
  status: string,
  at: Date,
  code: string | null = null,
  message: string | null = null,
) => ({
  status,
  at: at.toISOString(),
  code,
  message,
});

describe('buildDocumentEvents (HU-E12-02)', () => {
  it('a document that was only accepted has the single accepted event', () => {
    expect(buildDocumentEvents(input({}))).toEqual([event('accepted', created)]);
  });

  it('adds signed and the current status with the first SIFEN answer', () => {
    expect(
      buildDocumentEvents(
        input({ status: 'rejected', signedAt: signed, updatedAt: updated, messages: REJECTION }),
      ),
    ).toEqual([
      event('accepted', created),
      event('signed', signed),
      event('rejected', updated, '1321', 'Receptor innominado no permitido'),
    ]);
  });
});

describe('rejectionReasonOf', () => {
  it('joins the SIFEN messages of a rejected document', () => {
    expect(rejectionReasonOf('rejected', [...REJECTION, { code: '1', message: 'Otro' }])).toBe(
      'Receptor innominado no permitido; Otro',
    );
  });

  it('is null for any other status or without messages', () => {
    expect(rejectionReasonOf('approved_with_observations', REJECTION)).toBeNull();
    expect(rejectionReasonOf('rejected', [])).toBeNull();
  });
});
