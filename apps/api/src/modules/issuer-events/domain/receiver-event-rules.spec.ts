import { describe, expect, it } from 'vitest';
import { buildCdc } from '../../emission/domain/cdc.js';
import {
  DEFAULT_RECEIVER_EVENT_CONFIG,
  parseReceiverEventRequest,
  validateReceiverEvent,
  type PriorReceiverEvent,
  type ReceiverEventRequest,
} from './receiver-event-rules.js';

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

const base = { cdc: CDC, issuedAt: '2026-10-01T10:00:00' };

const request = (extra: Record<string, unknown>) =>
  parseReceiverEventRequest({ ...base, ...extra });
const parsed = (extra: Record<string, unknown>): ReceiverEventRequest => {
  const result = request(extra);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
};
const rules = (result: ReturnType<typeof request>) =>
  result.ok ? [] : result.issues.map((i) => `${i.field}:${i.rule}`);

const AT = new Date('2026-10-20T12:00:00Z');
const prior = (
  kind: PriorReceiverEvent['kind'],
  registeredAt = '2026-10-10T12:00:00Z',
  conformityType?: 'total' | 'partial',
): PriorReceiverEvent => ({ kind, registeredAt: new Date(registeredAt), conformityType });

/** Spec: HU-E9-01. MT v150 11.5-11.6, NT 019 (points 1, 2 and 5). */
describe('parseReceiverEventRequest', () => {
  it('parses each of the four kinds', () => {
    expect(parsed({ kind: 'conformity', conformityType: 'total' })).toMatchObject({
      kind: 'conformity',
      conformityType: 'total',
    });
    expect(parsed({ kind: 'disconformity', reason: ' mercadería dañada ' })).toMatchObject({
      reason: 'mercadería dañada',
    });
    expect(
      parsed({ kind: 'unawareness', reason: 'no la solicité', receivedAt: '2026-10-02T09:00:00' }),
    ).toMatchObject({ kind: 'unawareness' });
    expect(
      parsed({ kind: 'receipt_notice', receivedAt: '2026-10-02T09:00:00', totalPyg: 150000 }),
    ).toMatchObject({ kind: 'receipt_notice', totalPyg: 150000 });
  });

  it('refuses a body that is not an object, an unknown kind and a bad CDC', () => {
    expect(rules(parseReceiverEventRequest('x'))).toEqual(['body:body-invalid']);
    expect(rules(request({ kind: 'endorsement' }))).toEqual(['kind:kind-invalid']);
    expect(
      rules(
        parseReceiverEventRequest({
          kind: 'conformity',
          cdc: '123',
          issuedAt: base.issuedAt,
          conformityType: 'total',
        }),
      ),
    ).toContain('cdc:cdc-invalid');
  });

  it('requires the issue instant, in the date format of the manual, on the day of the CDC', () => {
    const noDate = parseReceiverEventRequest({
      kind: 'conformity',
      cdc: CDC,
      conformityType: 'total',
    });
    expect(rules(noDate)).toContain('issuedAt:issued-at-invalid');
    expect(
      rules(request({ kind: 'conformity', conformityType: 'total', issuedAt: '2026-10-01' })),
    ).toContain('issuedAt:issued-at-invalid');
    expect(
      rules(
        request({ kind: 'conformity', conformityType: 'total', issuedAt: '2026-10-02T10:00:00' }),
      ),
    ).toContain('issuedAt:issued-at-cdc-mismatch');
  });

  it('conformity: the type is total or partial; partial needs the estimated receipt date (4154), total refuses it', () => {
    expect(rules(request({ kind: 'conformity' }))).toContain(
      'conformityType:conformity-type-invalid',
    );
    expect(rules(request({ kind: 'conformity', conformityType: 'partial' }))).toContain(
      'estimatedReceiptAt:estimated-receipt-required',
    );
    expect(
      parsed({
        kind: 'conformity',
        conformityType: 'partial',
        estimatedReceiptAt: '2026-10-05T00:00:00',
      }),
    ).toMatchObject({ estimatedReceiptAt: '2026-10-05T00:00:00' });
    expect(
      rules(
        request({
          kind: 'conformity',
          conformityType: 'total',
          estimatedReceiptAt: '2026-10-05T00:00:00',
        }),
      ),
    ).toContain('estimatedReceiptAt:estimated-receipt-not-allowed');
  });

  it('disconformity and unawareness need a reason of 5 to 500 characters (mOtEve)', () => {
    expect(rules(request({ kind: 'disconformity', reason: 'no' }))).toContain(
      'reason:reason-length',
    );
    expect(rules(request({ kind: 'disconformity', reason: 'a'.repeat(501) }))).toContain(
      'reason:reason-length',
    );
    expect(parsed({ kind: 'disconformity', reason: 'a'.repeat(500) })).toBeDefined();
  });

  it('unawareness and notice need the reception instant, not before the issue (4104, 4254)', () => {
    expect(rules(request({ kind: 'unawareness', reason: 'no la solicité' }))).toContain(
      'receivedAt:received-at-invalid',
    );
    expect(
      rules(request({ kind: 'receipt_notice', receivedAt: '2026-09-30T23:59:59', totalPyg: 1 })),
    ).toContain('receivedAt:received-at-before-issue');
  });

  it('the notice needs the total in guaraníes, zero or more', () => {
    const at = { kind: 'receipt_notice', receivedAt: '2026-10-02T09:00:00' };
    expect(rules(request(at))).toContain('totalPyg:total-invalid');
    expect(rules(request({ ...at, totalPyg: -1 }))).toContain('totalPyg:total-invalid');
    expect(parsed({ ...at, totalPyg: 0 })).toBeDefined();
  });

  it('accepts the approval instant of a DTE with an offset or as Asunción wall-clock, and refuses garbage', () => {
    const a = parsed({
      kind: 'conformity',
      conformityType: 'total',
      approvedAt: '2026-10-01T13:30:00Z',
    });
    expect(a.approvedAt?.toISOString()).toBe('2026-10-01T13:30:00.000Z');
    const b = parsed({
      kind: 'conformity',
      conformityType: 'total',
      approvedAt: '2026-10-01T10:30:00',
    });
    expect(b.approvedAt?.toISOString()).toBe('2026-10-01T13:30:00.000Z');
    expect(
      rules(request({ kind: 'conformity', conformityType: 'total', approvedAt: 'ayer' })),
    ).toContain('approvedAt:approved-at-invalid');
  });
});

describe('validateReceiverEvent: deadline of 45 days (NT 019 2.1-2.4)', () => {
  const total = parsed({ kind: 'conformity', conformityType: 'total' });

  it('counts from the issue date of a DE and allows the last day', () => {
    expect(validateReceiverEvent(total, [], new Date('2026-11-14T12:00:00Z'))).toBeNull();
  });

  it('refuses after 45 days from the issue date, with the deadline', () => {
    const refusal = validateReceiverEvent(total, [], new Date('2026-11-15T14:00:00Z'));
    expect(refusal).toMatchObject({ rule: 'receiver-event-window-expired', sifenCode: '4157' });
    expect(refusal && 'deadline' in refusal && refusal.deadline.toISOString()).toBe(
      '2026-11-15T12:45:00.000Z',
    );
  });

  it('counts from the approval of a DTE, which is later than the issue', () => {
    const dte = parsed({
      kind: 'conformity',
      conformityType: 'total',
      approvedAt: '2026-10-10T10:00:00',
    });
    expect(validateReceiverEvent(dte, [], new Date('2026-11-20T00:00:00Z'))).toBeNull();
    expect(validateReceiverEvent(dte, [], new Date('2026-11-25T00:00:00Z'))?.rule).toBe(
      'receiver-event-window-expired',
    );
  });

  it('uses the SIFEN code of the kind and of DE or DTE', () => {
    const late = new Date('2027-01-31T00:00:00Z');
    const code = (extra: Record<string, unknown>) => {
      const r = validateReceiverEvent(parsed(extra), [], late);
      return r && 'sifenCode' in r ? r.sifenCode : undefined;
    };
    const rec = { receivedAt: '2026-10-02T09:00:00' };
    expect(code({ kind: 'conformity', conformityType: 'total' })).toBe('4157');
    expect(code({ kind: 'disconformity', reason: 'mercadería dañada' })).toBe('4206');
    expect(code({ kind: 'unawareness', reason: 'no la solicité', ...rec })).toBe('4253');
    expect(
      code({
        kind: 'unawareness',
        reason: 'no la solicité',
        approvedAt: '2026-10-02T00:00:00',
        ...rec,
      }),
    ).toBe('4263');
    expect(code({ kind: 'receipt_notice', totalPyg: 1, ...rec })).toBe('4103');
    expect(
      code({ kind: 'receipt_notice', totalPyg: 1, approvedAt: '2026-10-02T00:00:00', ...rec }),
    ).toBe('4114');
  });

  it('takes the window from the configuration', () => {
    const config = { ...DEFAULT_RECEIVER_EVENT_CONFIG, windowDays: 10 };
    expect(validateReceiverEvent(total, [], new Date('2026-10-20T00:00:00Z'), config)?.rule).toBe(
      'receiver-event-window-expired',
    );
  });
});

describe('validateReceiverEvent: compatibility between events', () => {
  const total = parsed({ kind: 'conformity', conformityType: 'total' });
  const partial = parsed({
    kind: 'conformity',
    conformityType: 'partial',
    estimatedReceiptAt: '2026-10-05T00:00:00',
  });
  const disconf = parsed({ kind: 'disconformity', reason: 'mercadería dañada' });
  const descon = parsed({
    kind: 'unawareness',
    reason: 'no la solicité',
    receivedAt: '2026-10-02T09:00:00',
  });
  const notice = parsed({ kind: 'receipt_notice', receivedAt: '2026-10-02T09:00:00', totalPyg: 1 });
  const noticeDte = parsed({
    kind: 'receipt_notice',
    receivedAt: '2026-10-02T09:00:00',
    totalPyg: 1,
    approvedAt: '2026-10-02T00:00:00',
  });
  const rule = (r: ReceiverEventRequest, history: PriorReceiverEvent[]) => {
    const refusal = validateReceiverEvent(r, history, AT);
    return refusal && 'sifenCode' in refusal
      ? `${refusal.rule}:${refusal.sifenCode}`
      : refusal?.rule;
  };

  it('allows each kind as the first event, and conformity partial then total (4150)', () => {
    for (const r of [total, partial, disconf, descon, notice]) expect(rule(r, [])).toBeUndefined();
    expect(rule(total, [prior('conformity', undefined, 'partial')])).toBeUndefined();
  });

  it('allows at most one event of each kind, and partial only before total', () => {
    expect(rule(total, [prior('conformity', undefined, 'total')])).toBe(
      'receiver-event-already-registered:4150',
    );
    expect(rule(partial, [prior('conformity', undefined, 'total')])).toBe(
      'receiver-event-already-registered:4150',
    );
    expect(rule(partial, [prior('conformity', undefined, 'partial')])).toBe(
      'receiver-event-already-registered:4150',
    );
    expect(rule(disconf, [prior('disconformity')])).toBe('receiver-event-already-registered:4200');
    expect(rule(descon, [prior('unawareness')])).toBe('receiver-event-already-registered:4251');
    expect(rule(notice, [prior('receipt_notice')])).toBe('receiver-event-already-registered:4101');
  });

  it('refuses conformity, disconformity and notice after an unawareness', () => {
    const history = [prior('unawareness')];
    expect(rule(total, history)).toBe('receiver-event-incongruent:4156');
    expect(rule(disconf, history)).toBe('receiver-event-incongruent:4205');
    expect(rule(notice, history)).toBe('receiver-event-incongruent:4113');
  });

  it('refuses a notice of a DTE after a conformity, disconformity; allows it for a DE', () => {
    expect(rule(noticeDte, [prior('conformity', undefined, 'total')])).toBe(
      'receiver-event-incongruent:4113',
    );
    expect(rule(noticeDte, [prior('disconformity')])).toBe('receiver-event-incongruent:4113');
    expect(rule(notice, [prior('disconformity')])).toBeUndefined();
  });

  it('an opposite event after the last conformity, disconformity or unawareness is a correction, not a new event', () => {
    expect(rule(disconf, [prior('conformity', undefined, 'total')])).toBe(
      'receiver-event-needs-correction',
    );
    expect(rule(total, [prior('disconformity')])).toBe('receiver-event-needs-correction');
    expect(rule(descon, [prior('disconformity')])).toBe('receiver-event-needs-correction');
    expect(rule(descon, [prior('conformity', undefined, 'partial')])).toBe(
      'receiver-event-needs-correction',
    );
  });

  it('a notice does not make the next event a correction', () => {
    expect(rule(total, [prior('receipt_notice')])).toBeUndefined();
  });

  it('only the last event decides whether it is a correction', () => {
    const history = [
      prior('conformity', '2026-10-05T00:00:00Z', 'total'),
      prior('disconformity', '2026-10-06T00:00:00Z'),
    ];
    expect(rule(total, history)).toBe('receiver-event-already-registered:4150');
  });
});
