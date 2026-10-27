import { describe, expect, it, vi } from 'vitest';
import { CertificateExpiringError, InvoiceValidationError } from './accept-invoice.js';
import { createAcceptRemission, type AcceptRemissionInput } from './accept-standalone.js';
import type { RemissionDraft } from '../domain/remission-draft.js';
import type { AcceptanceUnit } from './ports/acceptance-unit-of-work.port.js';

const place = {
  address: 'Calle 1',
  houseNumber: '10',
  departmentCode: 11,
  districtCode: 143,
  cityCode: 3344,
};
const draft: RemissionDraft = {
  motive: 1,
  responsible: 1,
  km: 120,
  receiver: { ruc: '80000002-1', name: 'Receptor Prueba SA', ...place },
  transport: {
    type: 1,
    modality: 1,
    freightResponsible: 1,
    startDate: '2026-10-01',
    endDate: '2026-10-02',
    departure: place,
    delivery: place,
    vehicle: { type: 'Camion', brand: 'Volvo', idType: 1, idNumber: 'ABC12345' },
    carrier: {
      contributor: true,
      name: 'Transportes SA',
      ruc: '80000003-0',
      address: 'Ruta 2 km 10',
      driver: { name: 'Pedro Gomez', idNumber: '1234567', address: 'Calle 9' },
    },
  },
  items: [{ quantity: 3 }],
};
const INPUT: AcceptRemissionInput = {
  tenantId: 't1',
  actor: { type: 'api_key', id: 'k' },
  establishmentCode: '001',
  expeditionPointCode: '002',
  draft,
  payload: { type: 'NRE' },
  idempotencyKey: 'key-1',
};

/** Spec: HU-E7-04. An NRE is type 7, own numbering, no money, and motive 7 is checked against the issuer. */
describe('acceptRemission', () => {
  function run(certificateNotAfter?: Date) {
    const insertDocument = vi.fn(() => Promise.resolve({ id: 'new' }));
    const nextNumber = vi.fn(() => Promise.resolve({ series: null, number: 9 }));
    const unit = {
      findByIdempotencyKey: () => Promise.resolve(null),
      resolveIssuer: () =>
        Promise.resolve({
          environment: 'test' as const,
          rucBase: '80000002',
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
    const accept = createAcceptRemission({
      unitOfWork: { run: (_tenant, work) => work(unit) },
      now: () => new Date('2026-03-06T01:30:00Z'),
    });
    return { accept, insertDocument, nextNumber };
  }

  it('takes a type 7 number and stores an NRE CDC with the receiver and a zero total', async () => {
    const { accept, insertDocument, nextNumber } = run();

    const accepted = await accept(INPUT);

    expect(nextNumber).toHaveBeenCalledWith(expect.anything(), 7);
    expect(accepted.cdc.startsWith('07')).toBe(true);
    expect(insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({ documentType: 7, receiverRuc: '80000002-1', totalAmount: '0' }),
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

  it('refuses motive 7 to another RUC (2606) after resolving the issuer and before numbering', async () => {
    const { accept, nextNumber } = run();

    const error = await accept({
      ...INPUT,
      draft: { ...draft, motive: 7, receiver: { ...draft.receiver, ruc: '80000004-8' } },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvoiceValidationError);
    expect((error as InvoiceValidationError).errors[0]?.sifenCode).toBe('2606');
    expect(nextNumber).not.toHaveBeenCalled();
  });

  it('accepts motive 7 addressed to the issuer', async () => {
    const { accept } = run();
    await expect(accept({ ...INPUT, draft: { ...draft, motive: 7 } })).resolves.toBeDefined();
  });

  /** Spec: HU-E3-03. */
  it('refuses before numbering when the certificate expires within a day', async () => {
    const { accept, nextNumber } = run(new Date('2026-03-07T01:00:00Z'));

    await expect(accept(INPUT)).rejects.toBeInstanceOf(CertificateExpiringError);
    expect(nextNumber).not.toHaveBeenCalled();
  });

  it('accepts a foreign receiver for an export and stores no receiver RUC', async () => {
    const { accept, insertDocument } = run();
    const receiver = { name: 'Foreign Co', idType: 2, idNumber: 'P123456', ...place };

    await accept({ ...INPUT, draft: { ...draft, motive: 3, receiver } });

    expect(insertDocument).toHaveBeenCalledWith(
      expect.objectContaining({ documentType: 7, receiverRuc: null }),
    );
  });
});
