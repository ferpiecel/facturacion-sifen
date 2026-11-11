import { describe, expect, it, vi } from 'vitest';
import { CertificateExpiringError, InvoiceValidationError } from './accept-invoice.js';
import { createAcceptSelfInvoice, type AcceptSelfInvoiceInput } from './accept-standalone.js';
import type { AcceptanceUnit } from './ports/acceptance-unit-of-work.port.js';

const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const draft = {
  seller: { nature: 1, idType: 1, idNumber: '1234567', name: 'Juan Perez', ...place },
  place,
  certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
  items: [{ quantity: 2, unitPrice: 50_000, vatRate: 0 as const }],
  roundingPyg: 0,
};
const INPUT: AcceptSelfInvoiceInput = {
  tenantId: 't1',
  actor: { type: 'api_key', id: 'k' },
  establishmentCode: '001',
  expeditionPointCode: '002',
  draft,
  payload: { type: 'AFE', ...draft },
  idempotencyKey: 'key-1',
};

/** Spec: HU-E7-03. An AFE is type 4, own numbering, and its receiver is the issuer (D206 = D101). */
describe('acceptSelfInvoice', () => {
  function run(certificateNotAfter?: Date) {
    const insertDocument = vi.fn(() => Promise.resolve({ id: 'new' }));
    const nextNumber = vi.fn(() => Promise.resolve({ series: null, number: 9 }));
    const unit = {
      findByIdempotencyKey: () => Promise.resolve(null),
      resolveIssuer: () =>
        Promise.resolve({
          environment: 'test' as const,
          rucBase: '80069563',
          rucDv: 1,
          taxpayerType: 2 as const,
          timbradoId: 'tim',
          establishmentId: 'est',
          expeditionPointId: 'pt',
          certificateNotAfter,
        }),
      nextNumber,
      insertDocument,
      recordAudit: () => Promise.resolve(),
    } as unknown as AcceptanceUnit;
    const accept = createAcceptSelfInvoice({
      unitOfWork: { run: (_tenant, work) => work(unit) },
      now: () => new Date('2026-03-06T01:30:00Z'),
    });
    return { accept, insertDocument, nextNumber };
  }

  it('takes a type 4 number and stores an AFE CDC addressed to the issuer', async () => {
    const { accept, insertDocument, nextNumber } = run();

    const accepted = await accept(INPUT);

    expect(nextNumber).toHaveBeenCalledWith(expect.anything(), 4);
    expect(accepted.cdc.startsWith('04')).toBe(true);
    expect(insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 4,
        receiverRuc: '80069563-1',
        totalAmount: '100000',
      }),
    );
  });

  it('refuses an invalid draft before numbering, so no number is burned', async () => {
    const { accept, nextNumber } = run();

    const error = await accept({ ...INPUT, draft: { ...draft, items: [] } }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(InvoiceValidationError);
    expect(nextNumber).not.toHaveBeenCalled();
  });

  /** Spec: HU-E3-03. */
  it('refuses before numbering when the certificate expires within a day', async () => {
    const { accept, nextNumber } = run(new Date('2026-03-07T01:00:00Z'));

    await expect(accept(INPUT)).rejects.toBeInstanceOf(CertificateExpiringError);
    expect(nextNumber).not.toHaveBeenCalled();
  });
});
