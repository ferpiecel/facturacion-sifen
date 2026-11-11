import { describe, expect, it } from 'vitest';
import { RECEIVED_FIELD_NAMES } from './confidence-policy.js';
import {
  EXTRACTION_OUTPUT_JSON_SCHEMA,
  parseLlmExtractionOutput,
} from './extraction-output-schema.js';

const confidences = Object.fromEntries(RECEIVED_FIELD_NAMES.map((n) => [n, 0.9]));

const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  cdc: null,
  issuerRuc: '80000000-3',
  issuerLegalName: 'Almacen Don Jose',
  documentNumber: '002-001-0014228',
  issueDate: '2026-01-27',
  receiverRuc: '80000001-8',
  paymentCondition: 'cash',
  totals: {
    exempt: '0',
    exonerated: '0',
    taxable5: '0',
    taxable10: '45454.55',
    vat5: '0',
    vat10: '4545.45',
    total: '50000',
  },
  items: [
    {
      description: 'Detergente 1L',
      productCode: null,
      quantity: '2',
      unitOfMeasure: 'un',
      unitPrice: '25000',
      discount: '0',
      subtotal: '50000',
      vatRate: 10,
      taxableBase: null,
      vatAmount: null,
    },
  ],
  fieldConfidences: confidences,
  overallConfidence: 0.85,
  notes: '',
  ...over,
});

const json = (over: Record<string, unknown> = {}): string => JSON.stringify(valid(over));

function ok(text: string) {
  const outcome = parseLlmExtractionOutput(text);
  if (!outcome.ok)
    throw new Error(`expected ok, got ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

function failure(text: string) {
  const outcome = parseLlmExtractionOutput(text);
  if (outcome.ok) throw new Error('expected a failure');
  return outcome.error;
}

describe('parseLlmExtractionOutput', () => {
  it('parses a valid object keeping amounts as strings', () => {
    const { result, notes } = ok(json());
    expect(result.totals?.taxable10).toBe('45454.55');
    expect(result.items[0]?.subtotal).toBe('50000');
    expect(result.overallConfidence).toBe(0.85);
    expect(result.fieldConfidences.totals).toBe(0.9);
    expect(notes).toBe('');
  });

  it('parses JSON wrapped in a json code fence', () => {
    expect(ok('```json\n' + json() + '\n```').result.issuerRuc).toBe('80000000-3');
  });

  it('parses JSON wrapped in a bare code fence', () => {
    expect(ok('```\n' + json() + '\n```').result.documentNumber).toBe('002-001-0014228');
  });

  it('parses JSON surrounded by leading and trailing prose', () => {
    const text = `Here is the extraction you asked for:\n${json()}\nLet me know if you need more.`;
    expect(ok(text).result.issuerLegalName).toBe('Almacen Don Jose');
  });

  it('defaults missing notes to an empty string', () => {
    const rest = Object.fromEntries(Object.entries(valid()).filter(([key]) => key !== 'notes'));
    expect(ok(JSON.stringify(rest)).notes).toBe('');
  });

  it('rejects text that is not JSON', () => {
    expect(failure('this is not json').code).toBe('not_json');
    expect(failure('').code).toBe('not_json');
    expect(failure('{"cdc": ').code).toBe('not_json');
  });

  it('rejects JSON that is not an object', () => {
    expect(failure('[1, 2]').code).toBe('not_json');
    expect(failure('42').code).toBe('not_json');
  });

  it('rejects a missing required key and names it', () => {
    const rest = Object.fromEntries(Object.entries(valid()).filter(([key]) => key !== 'totals'));
    const error = failure(JSON.stringify(rest));
    expect(error.code).toBe('schema_violation');
    expect(error.message).toContain('totals');
  });

  it('rejects unknown keys', () => {
    expect(failure(json({ surprise: true })).code).toBe('schema_violation');
  });

  it.each([
    ['overall above 1', { overallConfidence: 1.5 }],
    ['overall below 0', { overallConfidence: -0.1 }],
    ['field confidence above 1', { fieldConfidences: { ...confidences, totals: 2 } }],
    ['field confidence missing', { fieldConfidences: { ...confidences, items: undefined } }],
  ])('rejects confidences out of range: %s', (_name, over) => {
    expect(failure(json(over)).code).toBe('schema_violation');
  });

  it('rejects a numeric amount instead of coercing it', () => {
    const numeric = { ...(valid().totals as object), total: 50000 };
    const error = failure(json({ totals: numeric }));
    expect(error.code).toBe('schema_violation');
    expect(error.message).toContain('totals.total');
  });

  it('rejects a numeric item amount', () => {
    const item = { ...(valid().items as object[])[0], unitPrice: 25000 };
    expect(failure(json({ items: [item] })).message).toContain('items.0.unitPrice');
  });

  it('rejects a malformed decimal string through the domain parser', () => {
    const bad = { ...(valid().totals as object), vat10: 'abc' };
    expect(failure(json({ totals: bad })).code).toBe('schema_violation');
  });

  it('rejects an invented payment condition or VAT rate', () => {
    expect(failure(json({ paymentCondition: 'contado' })).code).toBe('schema_violation');
    const item = { ...(valid().items as object[])[0], vatRate: 7 };
    expect(failure(json({ items: [item] })).code).toBe('schema_violation');
  });

  it('accepts null totals and no items', () => {
    const { result } = ok(json({ totals: null, items: [] }));
    expect(result.totals).toBeNull();
    expect(result.items).toEqual([]);
  });
});

describe('EXTRACTION_OUTPUT_JSON_SCHEMA', () => {
  it('forbids additional properties and requires every top-level key', () => {
    const schema = EXTRACTION_OUTPUT_JSON_SCHEMA as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(['issuerRuc', 'totals', 'items']));
    expect(Object.keys(schema.properties ?? {})).toContain('fieldConfidences');
  });
});
