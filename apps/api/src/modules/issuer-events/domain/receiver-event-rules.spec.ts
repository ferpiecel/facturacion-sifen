import { describe, expect, it } from 'vitest';
import { buildCdc } from '../../emission/domain/cdc.js';
import { parseReceiverEventRequest, type ReceiverEventRequest } from './receiver-event-rules.js';

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
