import { describe, expect, it } from 'vitest';
import { createReceivedDocument } from '../domain/received-document.js';
import { RECEIVED_FIELD_NAMES } from '../domain/confidence-policy.js';
import { preserveCorrections, type MachineExtraction } from './preserve-corrections.js';
import type {
  FieldConfidence,
  ReceivedDocumentItem,
} from './ports/received-document-repository.port.js';
import { InMemoryReceptionRepository } from './testing/in-memory-reception.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const HUMAN_AT = new Date('2026-11-09T10:00:00.000Z');

const item = (description: string, position: number): ReceivedDocumentItem => ({
  position,
  description,
  productCode: null,
  quantity: '1',
  unitOfMeasure: null,
  unitPrice: '100',
  discount: null,
  subtotal: '100',
  vatRate: 10,
  taxableBase: '91',
  vatAmount: '9',
});

const row = (fieldName: string, over: Partial<FieldConfidence> = {}): FieldConfidence => ({
  fieldName,
  confidence: '0.900',
  extractedValue: `old ${fieldName}`,
  correctedValue: null,
  correctedBy: null,
  correctedAt: null,
  ...over,
});

const corrected = (fieldName: string) =>
  row(fieldName, {
    correctedValue: `human ${fieldName}`,
    correctedBy: 'key-1',
    correctedAt: HUMAN_AT,
  });

const machine = (over: Partial<MachineExtraction> = {}): MachineExtraction => ({
  header: {
    cdc: null,
    issuerLegalName: 'Machine SA',
    receiverRucBase: '80000001',
    receiverRucDv: 1,
    totalAmount: '999',
    totalPyg: '999',
    paymentCondition: 'credit',
    rawData: { source: 'vision' },
    extractionErrorCode: null,
  },
  items: [item('machine item', 1)],
  confidences: RECEIVED_FIELD_NAMES.map((name) =>
    row(name, { confidence: '0.700', extractedValue: `new ${name}` }),
  ),
  ...over,
});

async function graphWith(
  confidences: FieldConfidence[],
  header: Parameters<InMemoryReceptionRepository['create']>[1]['header'] = {},
) {
  const repository = new InMemoryReceptionRepository();
  await repository.create(TENANT, {
    document: createReceivedDocument({
      id: 'doc-1',
      tenantId: TENANT,
      source: 'pdf',
      isOwnReceiver: true,
    }),
    header: {
      issuerLegalName: 'Human SA',
      receiverRucBase: '80000009',
      receiverRucDv: 9,
      totalAmount: '110',
      totalPyg: '110',
      ...header,
    },
    items: [item('human item', 1), item('second', 2)],
    confidences,
  });
  const graph = await repository.load(TENANT, 'doc-1');
  if (graph === null) throw new Error('missing graph');
  return graph;
}

describe('preserveCorrections', () => {
  it('passes the machine output through when nothing was corrected', async () => {
    const graph = await graphWith(RECEIVED_FIELD_NAMES.map((name) => row(name)));
    const result = preserveCorrections(graph, machine());

    expect(result.preservedFields).toEqual([]);
    expect(result.keepItems).toBe(false);
    expect(result.header).toEqual(machine().header);
    expect(result.items).toEqual(machine().items);
    expect(result.confidences).toEqual(machine().confidences);
  });

  it('keeps the stored columns of a corrected field and the other fields take the machine output', async () => {
    const graph = await graphWith([
      ...RECEIVED_FIELD_NAMES.filter((n) => n !== 'receiver_ruc' && n !== 'totals').map((n) =>
        row(n),
      ),
      corrected('receiver_ruc'),
      corrected('totals'),
    ]);
    const result = preserveCorrections(graph, machine());

    expect(result.preservedFields).toEqual(['receiver_ruc', 'totals']);
    expect(result.header).toEqual({
      issuerLegalName: 'Machine SA',
      cdc: null,
      paymentCondition: 'credit',
      rawData: { source: 'vision' },
      extractionErrorCode: null,
    });
    expect(result.merged.header).toMatchObject({
      issuerLegalName: 'Machine SA',
      receiverRucBase: '80000009',
      receiverRucDv: 9,
      totalAmount: '110',
    });
  });

  it('keeps corrected_* on a corrected row and refreshes what the machine reads now', async () => {
    const graph = await graphWith([
      ...RECEIVED_FIELD_NAMES.filter((n) => n !== 'issuer_legal_name').map((n) => row(n)),
      corrected('issuer_legal_name'),
    ]);
    const result = preserveCorrections(graph, machine());
    const kept = result.confidences.find((r) => r.fieldName === 'issuer_legal_name');

    expect(kept).toEqual({
      fieldName: 'issuer_legal_name',
      confidence: '0.700',
      extractedValue: 'new issuer_legal_name',
      correctedValue: 'human issuer_legal_name',
      correctedBy: 'key-1',
      correctedAt: HUMAN_AT,
    });
    expect(result.header).not.toHaveProperty('issuerLegalName');
    const untouched = result.confidences.find((r) => r.fieldName === 'totals');
    expect(untouched).toMatchObject({ correctedValue: null, extractedValue: 'new totals' });
  });

  it('keeps every stored item, soft-removed ones included, when the items were corrected', async () => {
    const graph = await graphWith([
      ...RECEIVED_FIELD_NAMES.filter((n) => n !== 'items').map((n) => row(n)),
      corrected('items'),
    ]);
    const result = preserveCorrections(graph, machine());

    expect(result.keepItems).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.merged.items.map((i) => i.description)).toEqual(['human item', 'second']);
  });

  it('never erases a stored CDC with a null one while it preserves a correction', async () => {
    const graph = await graphWith(
      [...RECEIVED_FIELD_NAMES.map((n) => row(n)), corrected('totals')],
      {
        cdc: 'stored-cdc',
      },
    );
    // `corrected('totals')` above comes after the plain row, so the later row wins in the map.
    const result = preserveCorrections(graph, machine());
    expect(result.header).not.toHaveProperty('cdc');
    expect(result.merged.header.cdc).toBe('stored-cdc');
  });
});
