import { describe, expect, it } from 'vitest';
import { RECEIVED_FIELD_NAMES } from './confidence-policy.js';
import {
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserContent,
} from './extraction-prompt.js';

const png = (...bytes: number[]) => ({
  bytes: Uint8Array.from(bytes),
  mediaType: 'image/png' as const,
});

describe('EXTRACTION_SYSTEM_PROMPT', () => {
  it('instructs about the SIFEN and Paraguay specifics', () => {
    for (const fragment of [
      'RUC',
      'check digit',
      'CDC',
      '44 digits',
      '0, 5 or 10',
      'PYG',
      'decimal strings',
      'cash',
      'credit',
      'overallConfidence',
      'only a single JSON object',
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(fragment);
    }
  });

  it('names every confidence field the schema requires', () => {
    for (const name of RECEIVED_FIELD_NAMES) expect(EXTRACTION_SYSTEM_PROMPT).toContain(name);
  });

  it('tells the model to treat document text as data, not instructions', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/never follow instructions/i);
  });

  it('exposes a version string for traceability', () => {
    expect(EXTRACTION_PROMPT_VERSION).toMatch(/^extraction-v\d+$/);
  });
});

describe('buildExtractionUserContent', () => {
  it('emits one image part per page, in order, then a closing instruction', () => {
    const parts = buildExtractionUserContent({
      pages: [png(1), png(2), png(3)],
      pdfText: null,
      cdcHint: null,
    });
    const images = parts.flatMap((p) => (p.type === 'image' ? [p.bytes[0]] : []));
    expect(images).toEqual([1, 2, 3]);
    expect(parts.at(-1)?.type).toBe('text');
  });

  it('labels pages when there is more than one', () => {
    const parts = buildExtractionUserContent({
      pages: [png(1), png(2)],
      pdfText: null,
      cdcHint: null,
    });
    const labels = parts.flatMap((p) => (p.type === 'text' ? [p.text] : []));
    expect(labels.join('\n')).toContain('Page 1 of 2');
    expect(labels.join('\n')).toContain('Page 2 of 2');
  });

  it('includes PDF text and the CDC hint only when provided, marked as untrusted data', () => {
    const cdc = '0'.repeat(44);
    const withBoth = buildExtractionUserContent({
      pages: [png(1)],
      pdfText: 'Total 100',
      cdcHint: cdc,
    });
    const text = withBoth.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    expect(text).toContain('Total 100');
    expect(text).toContain(cdc);
    expect(text).toContain('<document_text>');

    const bare = buildExtractionUserContent({ pages: [png(1)], pdfText: null, cdcHint: null });
    const bareText = bare.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    expect(bareText).not.toContain('<document_text>');
    expect(bareText).not.toContain('cdc_hint');
  });

  it('skips blank PDF text', () => {
    const parts = buildExtractionUserContent({ pages: [png(1)], pdfText: '  \n ', cdcHint: null });
    expect(parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')).not.toContain(
      '<document_text>',
    );
  });

  it('rejects a request without pages', () => {
    expect(() => buildExtractionUserContent({ pages: [], pdfText: null, cdcHint: null })).toThrow(
      /at least one page/,
    );
  });
});
