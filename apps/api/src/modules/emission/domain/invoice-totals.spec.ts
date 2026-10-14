import { describe, expect, it } from 'vitest';
import type { DraftItem, InvoiceDraft } from './invoice-draft.js';
import { invoiceTotals, lineTotal } from './invoice-totals.js';

const named = { kind: 'named', isPublicEntity: false } as const;

function draft(items: DraftItem[], roundingPyg = 0): InvoiceDraft {
  return {
    receiver: named,
    operationType: 'B2B',
    items,
    roundingPyg,
    location: {},
  };
}

/** The arithmetic accept-invoice.ts and invoice-xml.ts used before HU-E5-09. */
function legacyNet(d: InvoiceDraft): string {
  const gross = d.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  return String(gross - d.roundingPyg);
}

describe('lineTotal', () => {
  it('is the exact product', () => {
    expect(lineTotal({ quantity: 2.3, unitPrice: 100, vatRate: 10 })?.toString()).toBe('230');
    expect(lineTotal({ quantity: 0.5, unitPrice: 1001, vatRate: 10 })?.toString()).toBe('500.5');
  });

  it('is undefined when the line cannot be represented exactly', () => {
    expect(lineTotal({ quantity: 0.00001, unitPrice: 0.0001, vatRate: 10 })).toBeUndefined();
    expect(lineTotal({ quantity: Number.NaN, unitPrice: 1, vatRate: 10 })).toBeUndefined();
  });
});

describe('invoiceTotals', () => {
  it('sums exactly and subtracts the rounding', () => {
    const totals = invoiceTotals(
      draft(
        [
          { quantity: 2.3, unitPrice: 100, vatRate: 10 },
          { quantity: 0.1, unitPrice: 0.2, vatRate: 5 },
        ],
        30.02,
      ),
    );
    expect(totals.gross.toString()).toBe('230.02');
    expect(totals.net.toString()).toBe('200');
  });

  it('throws for a draft that was not validated', () => {
    expect(() =>
      invoiceTotals(draft([{ quantity: Number.NaN, unitPrice: 1, vatRate: 10 }])),
    ).toThrow();
  });
});

describe('integer drafts keep byte-identical totals (HU-E5-09 invariant)', () => {
  const fixtures: InvoiceDraft[] = [
    // accept-invoice.spec.ts, invoice-xml.spec.ts, e2e and KuDE fixtures
    draft([{ quantity: 2, unitPrice: 55_000, vatRate: 10 }]),
    draft([{ quantity: 1, unitPrice: 107_437, vatRate: 10 }], 37),
    draft([{ quantity: 1, unitPrice: 110_000, vatRate: 10 }]),
    draft([{ quantity: 1, unitPrice: 47_789, vatRate: 10 }], 39),
    draft([{ quantity: 1, unitPrice: 0, vatRate: 0 }]),
    draft([{ quantity: 1, unitPrice: 999_999_999_999_950, vatRate: 10 }]),
    draft([
      { quantity: 3, unitPrice: 10_500, vatRate: 5 },
      { quantity: 7, unitPrice: 12_345, vatRate: 10 },
      { quantity: 1, unitPrice: 20_000, vatRate: 0 },
    ]),
  ];
  const quantities = [1, 2, 3, 7, 10, 12, 100, 1000];
  const prices = [0, 1, 50, 999, 1_000, 10_990, 107_437, 1_234_567];
  for (const quantity of quantities) {
    for (const unitPrice of prices) {
      const gross = quantity * unitPrice;
      fixtures.push(draft([{ quantity, unitPrice, vatRate: 10 }], gross % 50));
    }
  }

  it.each(fixtures.map((f, i) => [i, f] as const))('fixture %i', (_i, f) => {
    const totals = invoiceTotals(f);
    expect(totals.net.toString()).toBe(legacyNet(f));
  });
});
