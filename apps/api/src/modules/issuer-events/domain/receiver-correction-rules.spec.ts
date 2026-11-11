import { describe, expect, it } from 'vitest';
import { buildCdc } from '../../emission/domain/cdc.js';
import {
  parseReceiverEventRequest,
  type PriorReceiverEvent,
  type ReceiverEventRequest,
} from './receiver-event-rules.js';
import {
  validateCorrection,
  validateCorrectionReason,
  type CorrectableEvent,
} from './receiver-correction-rules.js';

const CDC = buildCdc({
  documentType: '01',
  rucBase: '80069563',
  rucDv: 1,
  establishment: '001',
  point: '001',
  documentNumber: '0000001',
  taxpayerType: 1,
  issueDate: '2026-10-01',
  emissionType: 1,
  securityCode: '123456789',
});
const AT = new Date('2026-10-20T12:00:00Z');
const parse = (extra: Record<string, unknown>): ReceiverEventRequest => {
  const r = parseReceiverEventRequest({ cdc: CDC, issuedAt: '2026-10-01T10:00:00', ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
};
const disconformity = parse({ kind: 'disconformity', reason: 'Mercadería dañada' });
const original = (o: Partial<CorrectableEvent> = {}): CorrectableEvent => ({
  kind: 'conformity',
  conformityType: 'total',
  status: 'approved',
  respondedAt: new Date('2026-10-15T12:00:00Z'),
  isCorrection: false,
  alreadyCorrected: false,
  isLatestConclusive: true,
  ...o,
});
const history = (e: CorrectableEvent): PriorReceiverEvent[] => [
  { kind: e.kind, conformityType: e.conformityType, registeredAt: e.respondedAt ?? AT },
];
const rule = (o: CorrectableEvent, r = disconformity, at = AT) => {
  const refusal = validateCorrection(o, r, history(o), at);
  return refusal?.rule;
};

/** Spec: HU-E9-02. MT v150 Tabla K and 11.6.4-11.6.6; NT 019 point 5. */
describe('validateCorrectionReason', () => {
  it('accepts 5 to 500 characters, trimmed', () => {
    expect(validateCorrectionReason('  por equivocación ')).toEqual({
      ok: true,
      value: 'por equivocación',
    });
    expect(validateCorrectionReason('abcd').ok).toBe(false);
    expect(validateCorrectionReason('a'.repeat(501)).ok).toBe(false);
    expect(validateCorrectionReason(undefined).ok).toBe(false);
  });
});

describe('validateCorrection', () => {
  it('accepts the opposite event within 15 days of the original', () => {
    expect(rule(original())).toBeUndefined();
    expect(
      rule(
        original({ kind: 'disconformity', conformityType: undefined }),
        parse({ kind: 'conformity', conformityType: 'total' }),
      ),
    ).toBeUndefined();
    expect(
      rule(
        original(),
        parse({ kind: 'unawareness', reason: 'No la solicité', receivedAt: '2026-10-02T09:00:00' }),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['an event SIFEN has not approved', { status: 'sending' }, 'correction-original-not-approved'],
    ['a receipt notice', { kind: 'receipt_notice' }, 'correction-kind-unsupported'],
    ['a correction', { isCorrection: true }, 'correction-of-correction'],
    ['an event already corrected', { alreadyCorrected: true }, 'correction-already-requested'],
    [
      'an event that a later one superseded',
      { isLatestConclusive: false },
      'correction-original-superseded',
    ],
    [
      'an unawareness, which nothing can follow',
      { kind: 'unawareness' },
      'receiver-event-incongruent',
    ],
  ] as const)('refuses to correct %s', (_name, change, expected) => {
    expect(rule(original(change as Partial<CorrectableEvent>))).toBe(expected);
  });

  it('refuses an event of the same kind: it is not a correction', () => {
    expect(
      rule(
        original(),
        parse({
          kind: 'conformity',
          conformityType: 'partial',
          estimatedReceiptAt: '2026-10-05T00:00:00',
        }),
      ),
    ).toBe('correction-kind-not-opposite');
  });

  it('counts the 15 days from the original, with the deadline', () => {
    const o = original({ respondedAt: new Date('2026-10-01T12:00:00Z') });
    const refusal = validateCorrection(o, disconformity, history(o), AT);
    expect(refusal).toMatchObject({ rule: 'correction-window-expired' });
    expect(refusal && 'deadline' in refusal && refusal.deadline.toISOString()).toBe(
      '2026-10-16T11:45:00.000Z',
    );
  });

  it('still applies the 45-day window of the document', () => {
    const late = new Date('2026-12-01T00:00:00Z');
    const o = original({ respondedAt: new Date('2026-11-30T00:00:00Z') });
    expect(validateCorrection(o, disconformity, history(o), late)?.rule).toBe(
      'receiver-event-window-expired',
    );
  });

  it('takes the 15 days from the configuration', () => {
    const o = original({ respondedAt: new Date('2026-10-18T12:00:00Z') });
    const config = { windowDays: 45, correctionDays: 1, safetyMarginMinutes: 15 };
    expect(validateCorrection(o, disconformity, history(o), AT, config)?.rule).toBe(
      'correction-window-expired',
    );
  });
});
