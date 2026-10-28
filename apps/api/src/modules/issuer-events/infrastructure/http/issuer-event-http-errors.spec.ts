import { describe, expect, it } from 'vitest';
import { EventKeyCollisionError } from '../../application/ports/cancellation-unit-of-work.port.js';
import {
  ReceiverCorrectionRefusedError,
  ReceiverEventNotFoundError,
} from '../../application/correct-receiver-event.js';
import { toIssuerEventHttpException } from './issuer-event-http-errors.js';

const status = (error: unknown) => toIssuerEventHttpException(error)?.getStatus();
const body = (error: unknown) =>
  toIssuerEventHttpException(error)?.getResponse() as {
    errors?: { rule: string; deadline?: string }[];
  };

describe('toIssuerEventHttpException', () => {
  it('answers 409 when the Idempotency-Key was taken by another kind of event', () => {
    expect(status(new EventKeyCollisionError())).toBe(409);
  });

  it('answers 404 for a receiver event the tenant does not have', () => {
    expect(status(new ReceiverEventNotFoundError())).toBe(404);
  });

  it('answers 422 with the rule of a refused correction, and the deadline of an expired one', () => {
    const expired = new ReceiverCorrectionRefusedError({
      rule: 'correction-window-expired',
      message: 'expired',
      deadline: new Date('2026-10-01T00:00:00Z'),
    });

    expect(status(expired)).toBe(422);
    expect(body(expired).errors?.[0]).toMatchObject({
      rule: 'correction-window-expired',
      deadline: '2026-10-01T00:00:00.000Z',
    });
  });

  it('answers 409 when the event was already corrected', () => {
    const again = new ReceiverCorrectionRefusedError({
      rule: 'correction-already-requested',
      message: 'again',
    });

    expect(status(again)).toBe(409);
  });
});
