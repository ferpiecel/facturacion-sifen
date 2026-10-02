import { describe, expect, it, vi } from 'vitest';
import { parseCdc } from '../domain/cdc.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import {
  createAcceptInvoice,
  InvoiceValidationError,
  IssuerNotConfiguredError,
  type AcceptInvoiceInput,
} from './accept-invoice.js';
import type {
  AcceptanceUnit,
  AcceptanceUnitOfWork,
  IssuerContext,
  NewDocument,
} from './ports/acceptance-unit-of-work.port.js';

const ISSUER: IssuerContext = {
  environment: 'test',
  rucBase: '80069563',
  rucDv: 1,
  taxpayerType: 2,
  timbradoId: 'tim-1',
  establishmentId: 'est-1',
  expeditionPointId: 'pt-1',
};

const DRAFT: InvoiceDraft = {
  receiver: { kind: 'named', isPublicEntity: false },
  operationType: 'B2B',
  items: [{ quantity: 2, unitPrice: 55_000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

function setup(issuer: IssuerContext | null = ISSUER) {
  const inserted: NewDocument[] = [];
  const resolveIssuer = vi.fn(() => Promise.resolve(issuer));
  const nextNumber = vi.fn(() =>
    Promise.resolve<{ series: string | null; number: number }>({ series: null, number: 7 }),
  );
  const insertDocument = vi.fn((doc: NewDocument) => {
    inserted.push(doc);
    return Promise.resolve({ id: 'doc-1' });
  });
  const recordAudit = vi.fn(() => Promise.resolve());
  const unit: AcceptanceUnit = { resolveIssuer, nextNumber, insertDocument, recordAudit };
  const run = vi.fn();
  const unitOfWork: AcceptanceUnitOfWork = {
    run: <T>(tenantId: string, work: (u: AcceptanceUnit) => Promise<T>) => {
      run(tenantId);
      return work(unit);
    },
  };
  const acceptInvoice = createAcceptInvoice({
    unitOfWork,
    // 2026-03-06T01:30Z is still 2026-03-05 in Paraguay (UTC-3).
    now: () => new Date('2026-03-06T01:30:00Z'),
  });
  const input: AcceptInvoiceInput = {
    tenantId: 'tenant-1',
    actor: { type: 'api_key', id: 'key-1' },
    establishmentCode: '001',
    expeditionPointCode: '002',
    draft: DRAFT,
    receiverRuc: '1234567-8',
    payload: { hello: 'world' },
  };
  return {
    acceptInvoice,
    input,
    mocks: { resolveIssuer, nextNumber, insertDocument, recordAudit, run },
    inserted,
  };
}

/** Spec: HU-E5-01 (S2). Accept, number and persist an FE. */
describe('acceptInvoice', () => {
  it('numbers the document, builds its CDC and persists it as accepted', async () => {
    const { acceptInvoice, input, inserted, mocks } = setup();

    const result = await acceptInvoice(input);

    expect(result).toEqual({ documentId: 'doc-1', cdc: inserted[0].cdc });
    expect(mocks.resolveIssuer).toHaveBeenCalledWith({
      establishmentCode: '001',
      expeditionPointCode: '002',
      issueDate: '2026-03-05',
    });
    expect(mocks.nextNumber).toHaveBeenCalledWith(ISSUER, 1);
    const parts = parseCdc(result.cdc);
    expect(parts).toMatchObject({
      documentType: '01',
      rucBase: '80069563',
      rucDv: 1,
      establishment: '001',
      point: '002',
      documentNumber: '0000007',
      taxpayerType: 2,
      issueDate: '2026-03-05',
      emissionType: 1,
    });
    expect(parts.securityCode).not.toBe('000000007');
    expect(inserted[0]).toMatchObject({
      environment: 'test',
      documentType: 1,
      timbradoId: 'tim-1',
      establishmentId: 'est-1',
      expeditionPointId: 'pt-1',
      series: '',
      number: 7,
      securityCode: parts.securityCode,
      receiverRuc: '1234567-8',
      totalAmount: '110000',
      currency: 'PYG',
      payload: { hello: 'world' },
    });
    expect(inserted[0].issuedAt).toEqual(new Date('2026-03-06T01:30:00Z'));
  });

  it('subtracts the rounding from the stored total', async () => {
    const { acceptInvoice, input, inserted } = setup();
    await acceptInvoice({
      ...input,
      draft: {
        ...DRAFT,
        items: [{ quantity: 1, unitPrice: 107_437, vatRate: 10 }],
        roundingPyg: 37,
      },
    });
    expect(inserted[0].totalAmount).toBe('107400');
  });

  it('records the series when numbering rolled over', async () => {
    const { acceptInvoice, input, inserted, mocks } = setup();
    mocks.nextNumber.mockResolvedValue({ series: 'AA', number: 1 });
    await acceptInvoice(input);
    expect(inserted[0]).toMatchObject({ series: 'AA', number: 1 });
  });

  it('audits the acceptance with the document id and CDC', async () => {
    const { acceptInvoice, input, mocks } = setup();
    const { cdc } = await acceptInvoice(input);
    expect(mocks.recordAudit).toHaveBeenCalledWith({
      actor: { type: 'api_key', id: 'key-1' },
      action: 'document.accepted',
      entity: { type: 'document', id: 'doc-1' },
      before: null,
      after: { cdc, status: 'accepted' },
    });
  });

  it('rejects an invalid draft before opening a transaction', async () => {
    const { acceptInvoice, input, mocks } = setup();
    const error = await acceptInvoice({ ...input, draft: { ...DRAFT, items: [] } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvoiceValidationError);
    expect((error as InvoiceValidationError).errors[0]).toMatchObject({ rule: 'items-required' });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('fails without numbering when the issuer setup does not resolve', async () => {
    const { acceptInvoice, input, mocks } = setup(null);
    await expect(acceptInvoice(input)).rejects.toBeInstanceOf(IssuerNotConfiguredError);
    expect(mocks.nextNumber).not.toHaveBeenCalled();
    expect(mocks.insertDocument).not.toHaveBeenCalled();
  });
});
