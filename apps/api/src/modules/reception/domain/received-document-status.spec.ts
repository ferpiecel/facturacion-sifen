import { describe, expect, it } from 'vitest';
import {
  InvalidStatusTransitionError,
  RECEIVED_DOCUMENT_STATUSES,
  STATUS_TRANSITIONS,
  assertTransition,
  canTransition,
  isReceivedDocumentStatus,
} from './received-document-status.js';
import { RECEIVED_DOCUMENT_SOURCES, isReceivedDocumentSource } from './source.js';

const VALID_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['received', 'extracting'],
  ['received', 'extracted'],
  ['extracting', 'extracted'],
  ['extracting', 'extraction_failed'],
  ['extracted', 'confirmed'],
  ['extracted', 'needs_review'],
  ['needs_review', 'confirmed'],
  ['extraction_failed', 'extracting'],
  ['confirmed', 'confirmed'],
];

describe('received document source', () => {
  it('lists the four ingestion sources', () => {
    expect(RECEIVED_DOCUMENT_SOURCES).toEqual(['sifen_xml', 'ekuatia_cdc', 'pdf', 'photo']);
  });

  it('guards unknown values', () => {
    expect(isReceivedDocumentSource('pdf')).toBe(true);
    expect(isReceivedDocumentSource('manual')).toBe(false);
    expect(isReceivedDocumentSource(null)).toBe(false);
  });
});

describe('received document status machine', () => {
  it('lists the six statuses', () => {
    expect(RECEIVED_DOCUMENT_STATUSES).toEqual([
      'received',
      'extracting',
      'extracted',
      'needs_review',
      'extraction_failed',
      'confirmed',
    ]);
    expect(isReceivedDocumentStatus('confirmed')).toBe(true);
    expect(isReceivedDocumentStatus('emitida')).toBe(false);
  });

  it('exports a table covering every status', () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...RECEIVED_DOCUMENT_STATUSES].sort());
  });

  it('accepts exactly the nine documented transitions across ALL (from, to) pairs', () => {
    const accepted: Array<readonly [string, string]> = [];
    for (const from of RECEIVED_DOCUMENT_STATUSES) {
      for (const to of RECEIVED_DOCUMENT_STATUSES) {
        if (canTransition(from, to)) accepted.push([from, to]);
      }
    }
    expect(accepted).toHaveLength(VALID_PAIRS.length);
    expect(new Set(accepted.map((p) => p.join('>')))).toEqual(
      new Set(VALID_PAIRS.map((p) => p.join('>'))),
    );
  });

  it.each(
    RECEIVED_DOCUMENT_STATUSES.flatMap((from) =>
      RECEIVED_DOCUMENT_STATUSES.map((to) => [from, to] as const),
    ),
  )('assertTransition %s -> %s agrees with the table', (from, to) => {
    const valid = VALID_PAIRS.some(([f, t]) => f === from && t === to);
    if (valid) {
      expect(() => {
        assertTransition(from, to);
      }).not.toThrow();
    } else {
      expect(() => {
        assertTransition(from, to);
      }).toThrow(InvalidStatusTransitionError);
    }
  });

  it('reports both statuses on an invalid transition', () => {
    try {
      assertTransition('confirmed', 'received');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStatusTransitionError);
      expect((error as InvalidStatusTransitionError).from).toBe('confirmed');
      expect((error as InvalidStatusTransitionError).to).toBe('received');
    }
  });
});
