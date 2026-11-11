import { describe, expect, it } from 'vitest';
import { parseCorrectionRequest } from './correct-received-document.request.js';

/** Spec: reception R4.4. Wire to use-case mapping of the PATCH body. */
describe('parseCorrectionRequest', () => {
  it('maps the nested wire names onto the flat patch and keeps null distinct from absent', () => {
    const parsed = parseCorrectionRequest({
      version: 3,
      confirm: true,
      issuer: { ruc: '80000000-1', trade_name: null },
      totals: { total_amount: '110000.5' },
      payment: { condition: 'credit' },
      items: [{ position: 2, vat_rate: 5, remove: false }],
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        expectedVersion: 3,
        confirm: true,
        header: {
          issuerRuc: '80000000-1',
          issuerTradeName: null,
          totalAmount: '110000.5',
          paymentCondition: 'credit',
        },
        items: [{ position: 2, vatRate: 5, remove: false }],
      },
    });
  });

  it('rejects unknown fields at every level, non-string amounts and bad shapes with paths only', () => {
    for (const body of [
      null,
      { version: 1, cdc: '1'.repeat(44) },
      { version: 1, issuer: { nope: 1 } },
      { version: 1, totals: { total_amount: 1 } },
      { version: 1, issued_on: '10/11/2026' },
      { version: 1, items: [{ position: 1, vat_rate: 7 }] },
    ]) {
      const parsed = parseCorrectionRequest(body);
      expect(parsed.ok, JSON.stringify(body)).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain('1111111111');
    }
  });
});
