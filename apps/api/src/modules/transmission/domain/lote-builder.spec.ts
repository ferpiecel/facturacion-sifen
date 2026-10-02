import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCdc, parseCdc } from '../../emission/domain/cdc.js';
import {
  EmptyLoteError,
  LoteBuilder,
  MAX_LOTE_DOCUMENTS,
  MAX_LOTE_MESSAGE_BYTES,
  type LoteDocument,
  type LoteBuilderDeps,
} from './lote-builder.js';

const RUC_A = { rucBase: '44444401', rucDv: 7 };
const RUC_B = { rucBase: '80000001', rucDv: 3 };

function cdcFor(n: number, opts: { ruc?: typeof RUC_A; type?: string } = {}): string {
  return buildCdc({
    documentType: opts.type ?? '01',
    ...(opts.ruc ?? RUC_A),
    establishment: '001',
    point: '001',
    documentNumber: String(n),
    taxpayerType: 2,
    issueDate: '2026-09-22',
    emissionType: 1,
    securityCode: '587326098',
  });
}

const doc = (
  n: number,
  opts: { ruc?: typeof RUC_A; type?: string; bytes?: number } = {},
): LoteDocument => ({
  cdc: cdcFor(n, opts),
  xml: 'x'.repeat(opts.bytes ?? 10),
});

const bytes = (xmls: readonly string[]): number => xmls.reduce((sum, xml) => sum + xml.length, 0);

function builder(overrides: Partial<LoteBuilderDeps> = {}): LoteBuilder {
  return new LoteBuilder({ isInProcess: () => false, measureMessage: bytes, ...overrides });
}

describe('LoteBuilder', () => {
  it('accepts documents of one RUC and one type', () => {
    const lote = builder();
    expect(lote.add(doc(1))).toEqual({ accepted: true });
    expect(lote.add(doc(2))).toEqual({ accepted: true });
    expect(lote.build().documents.map((d) => d.cdc)).toEqual([cdcFor(1), cdcFor(2)]);
  });

  it('exposes the RUC and document type fixed by the first document', () => {
    const lote = builder();
    lote.add(doc(1, { type: '04' }));
    expect(lote.build()).toMatchObject({ rucBase: '44444401', rucDv: 7, documentType: '04' });
  });

  it('rejects a document of another RUC', () => {
    const lote = builder();
    lote.add(doc(1));
    expect(lote.add(doc(2, { ruc: RUC_B }))).toEqual({ accepted: false, reason: 'ruc-mismatch' });
  });

  it('rejects a document of another type', () => {
    const lote = builder();
    lote.add(doc(1));
    expect(lote.add(doc(2, { type: '04' }))).toEqual({ accepted: false, reason: 'type-mismatch' });
  });

  it('rejects the 51st document', () => {
    const lote = builder();
    for (let n = 1; n <= MAX_LOTE_DOCUMENTS; n++) lote.add(doc(n));
    expect(lote.add(doc(51))).toEqual({ accepted: false, reason: 'lote-full' });
    expect(lote.build().documents).toHaveLength(MAX_LOTE_DOCUMENTS);
  });

  it('rejects a CDC already in the lote', () => {
    const lote = builder();
    lote.add(doc(1));
    expect(lote.add(doc(1))).toEqual({ accepted: false, reason: 'duplicate-cdc' });
  });

  it('rejects a CDC that is in another lote still in process', () => {
    const busy = new Set([cdcFor(2)]);
    const lote = builder({ isInProcess: (cdc) => busy.has(cdc) });
    expect(lote.add(doc(2))).toEqual({ accepted: false, reason: 'cdc-in-process' });
    expect(lote.add(doc(3))).toEqual({ accepted: true });
  });

  it('rejects a document that pushes the message over the size limit', () => {
    const lote = builder();
    lote.add(doc(1, { bytes: MAX_LOTE_MESSAGE_BYTES }));
    expect(lote.add(doc(2))).toEqual({ accepted: false, reason: 'size-exceeded' });
  });

  it('accepts a message of exactly the size limit on an empty builder', () => {
    expect(builder().add(doc(1, { bytes: MAX_LOTE_MESSAGE_BYTES }))).toEqual({ accepted: true });
  });

  it('does not fix the lote identity on a first document rejected as too big', () => {
    const lote = builder();
    expect(lote.add(doc(1, { bytes: MAX_LOTE_MESSAGE_BYTES + 1 }))).toEqual({
      accepted: false,
      reason: 'size-exceeded',
    });
    expect(lote.add(doc(2, { ruc: RUC_B, type: '04' }))).toEqual({ accepted: true });
    expect(lote.build()).toMatchObject({ rucBase: '80000001', documentType: '04' });
  });

  it('does not fix the lote identity on a first document rejected as in process', () => {
    const lote = builder({ isInProcess: (cdc) => cdc === cdcFor(1) });
    expect(lote.add(doc(1))).toEqual({ accepted: false, reason: 'cdc-in-process' });
    expect(lote.add(doc(2, { ruc: RUC_B, type: '04' }))).toEqual({ accepted: true });
    expect(lote.build()).toMatchObject({ rucBase: '80000001', documentType: '04' });
  });

  it('rejects a single document that alone exceeds the size limit', () => {
    expect(builder().add(doc(1, { bytes: MAX_LOTE_MESSAGE_BYTES + 1 }))).toEqual({
      accepted: false,
      reason: 'size-exceeded',
    });
  });

  it('leaves the lote unchanged after a rejection', () => {
    const lote = builder();
    lote.add(doc(1));
    lote.add(doc(1));
    lote.add(doc(2, { type: '04' }));
    expect(lote.build().documents).toHaveLength(1);
  });

  it('refuses to build an empty lote', () => {
    expect(() => builder().build()).toThrow(EmptyLoteError);
  });
});

describe('LoteBuilder invariants (property-based)', () => {
  const candidate = fc.record({
    n: fc.integer({ min: 1, max: 80 }),
    ruc: fc.constantFrom(RUC_A, RUC_B),
    type: fc.constantFrom('01', '04'),
    bytes: fc.integer({ min: 1, max: 400_000 }),
  });

  it('accepts a candidate if and only if no rejection condition holds (reference model)', () => {
    fc.assert(
      fc.property(
        fc.array(candidate, { minLength: 1, maxLength: 200 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 80 }), { maxLength: 20 }),
        (candidates, busyNumbers) => {
          const busy = new Set(busyNumbers.flatMap((n) => [cdcFor(n), cdcFor(n, { ruc: RUC_B })]));
          const lote = builder({ isInProcess: (cdc) => busy.has(cdc) });
          const model = {
            ruc: undefined as string | undefined,
            type: undefined as string | undefined,
          };
          const cdcs = new Set<string>();
          let total = 0;
          for (const c of candidates) {
            const d = doc(c.n, c);
            const holding = new Set<string>();
            if (model.ruc !== undefined && model.ruc !== c.ruc.rucBase) holding.add('ruc-mismatch');
            if (model.type !== undefined && model.type !== c.type) holding.add('type-mismatch');
            if (cdcs.size >= MAX_LOTE_DOCUMENTS) holding.add('lote-full');
            if (cdcs.has(d.cdc)) holding.add('duplicate-cdc');
            if (busy.has(d.cdc)) holding.add('cdc-in-process');
            if (total + c.bytes > MAX_LOTE_MESSAGE_BYTES) holding.add('size-exceeded');

            const result = lote.add(d);
            expect(result.accepted).toBe(holding.size === 0);
            if (result.accepted) {
              model.ruc = c.ruc.rucBase;
              model.type = c.type;
              cdcs.add(d.cdc);
              total += c.bytes;
            } else {
              expect(holding.has(result.reason)).toBe(true);
            }
          }
          expect(lote.size).toBe(cdcs.size);
        },
      ),
    );
  });

  it('never builds a lote that violates an invariant, whatever is offered', () => {
    fc.assert(
      fc.property(
        fc.array(candidate, { minLength: 1, maxLength: 200 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 80 }), { maxLength: 20 }),
        (candidates, busyNumbers) => {
          const busy = new Set(busyNumbers.flatMap((n) => [cdcFor(n), cdcFor(n, { ruc: RUC_B })]));
          const lote = builder({ isInProcess: (cdc) => busy.has(cdc) });
          for (const c of candidates) lote.add(doc(c.n, c));
          if (lote.size === 0) return;

          const built = lote.build();
          const cdcs = built.documents.map((d) => d.cdc);
          expect(cdcs.length).toBeLessThanOrEqual(MAX_LOTE_DOCUMENTS);
          expect(new Set(cdcs).size).toBe(cdcs.length);
          expect(cdcs.some((cdc) => busy.has(cdc))).toBe(false);
          expect(new Set(cdcs.map((cdc) => parseCdc(cdc).rucBase)).size).toBe(1);
          expect(new Set(cdcs.map((cdc) => parseCdc(cdc).documentType)).size).toBe(1);
          expect(bytes(built.documents.map((d) => d.xml))).toBeLessThanOrEqual(
            MAX_LOTE_MESSAGE_BYTES,
          );
        },
      ),
    );
  });
});
