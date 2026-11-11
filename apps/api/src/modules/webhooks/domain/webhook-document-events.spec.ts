import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES, createWebhookEvent } from './webhook-event.js';
import {
  documentEventData,
  deadlineWarningData,
  deadlineWarningEventId,
  documentEventId,
  eventTypeForDocumentStatus,
} from './webhook-document-events.js';

describe('document lifecycle events (HU-E11-01 outbox)', () => {
  it.each([
    ['accepted', 'document.created'],
    ['signed', 'document.signed'],
    ['submitted', 'document.submitted'],
    ['approved', 'document.approved'],
    ['approved_with_observations', 'document.approved_with_observations'],
    ['rejected', 'document.rejected'],
    ['cancelled', 'document.cancelled'],
    ['number_voided', 'document.number_voided'],
  ])('maps the status %s to %s', (status, type) => {
    expect(eventTypeForDocumentStatus(status)).toBe(type);
  });

  it.each(['queued', 'corrected', 'bogus', ''])('emits nothing for the status %j', (status) => {
    expect(eventTypeForDocumentStatus(status)).toBeUndefined();
  });

  it('only maps to known event types', () => {
    for (const status of ['accepted', 'signed', 'submitted', 'approved', 'rejected']) {
      expect(WEBHOOK_EVENT_TYPES).toContain(eventTypeForDocumentStatus(status));
    }
  });

  it('derives a deterministic, envelope-valid event id per document and event type', () => {
    const id = documentEventId('7c1d6f0e-0000-4000-8000-000000000001', 'document.approved');
    expect(id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(documentEventId('7c1d6f0e-0000-4000-8000-000000000001', 'document.approved')).toBe(id);
    expect(documentEventId('7c1d6f0e-0000-4000-8000-000000000001', 'document.rejected')).not.toBe(
      id,
    );
    expect(documentEventId('7c1d6f0e-0000-4000-8000-000000000002', 'document.approved')).not.toBe(
      id,
    );
    expect(() =>
      createWebhookEvent({
        id,
        type: 'document.approved',
        createdAt: new Date(),
        tenantId: 't',
        data: {},
      }),
    ).not.toThrow();
  });

  it('builds minimal data: ids, status and SIFEN messages, nothing else', () => {
    const data = documentEventData({
      id: 'doc-1',
      cdc: '0'.repeat(44),
      documentType: 1,
      status: 'rejected',
      sifenMessages: [{ code: '1321', message: 'Receptor innominado no permitido', extra: 'x' }],
    });
    expect(data).toEqual({
      document_id: 'doc-1',
      cdc: '0'.repeat(44),
      document_type: 1,
      status: 'rejected',
      sifen_messages: [{ code: '1321', message: 'Receptor innominado no permitido' }],
    });
  });

  it('omits messages when there are none and sanitizes malformed or oversized ones', () => {
    const source = { id: 'd', cdc: 'c', documentType: 1, status: 'approved' };
    expect(documentEventData({ ...source, sifenMessages: null })).not.toHaveProperty(
      'sifen_messages',
    );
    expect(documentEventData({ ...source, sifenMessages: 'nope' })).not.toHaveProperty(
      'sifen_messages',
    );
    const many = Array.from({ length: 50 }, (_, i) => ({
      code: String(i),
      message: 'm'.repeat(900),
    }));
    const out = documentEventData({ ...source, sifenMessages: [...many, 7, null, { code: 1 }] })
      .sifen_messages as { message: string }[];
    expect(out).toHaveLength(20);
    expect(out[0].message).toHaveLength(500);
  });
});

/** Spec: HU-E6-07. The deadline warning is one event per (document, threshold). */
describe('deadline warning events', () => {
  it('derives a stable id per document and threshold', () => {
    expect(deadlineWarningEventId('doc-1', 48)).toBe(deadlineWarningEventId('doc-1', 48));
    expect(deadlineWarningEventId('doc-1', 48)).not.toBe(deadlineWarningEventId('doc-1', 66));
    expect(deadlineWarningEventId('doc-1', 48)).not.toBe(deadlineWarningEventId('doc-2', 48));
    expect(deadlineWarningEventId('doc-1', 48)).toMatch(/^evt_[0-9a-f]{32}$/);
  });

  it('carries the CDC, the document id, the deadline and the hours remaining', () => {
    expect(
      deadlineWarningData({
        documentId: 'doc-1',
        cdc: 'cdc-1',
        thresholdHours: 66,
        deadline: new Date('2026-10-04T12:00:00.000Z'),
        hoursRemaining: 5.5,
      }),
    ).toEqual({
      document_id: 'doc-1',
      cdc: 'cdc-1',
      threshold_hours: 66,
      transmission_deadline: '2026-10-04T12:00:00.000Z',
      hours_remaining: 5.5,
    });
  });
});
