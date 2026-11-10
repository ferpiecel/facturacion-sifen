import type {
  ReceivedDocumentHeader,
  ReceivedDocumentItem,
} from './ports/received-document-repository.port.js';
import type { ReceivedDocumentFields } from '../domain/received-document-validation.js';

const ZERO = '0';

/**
 * Maps the stored (or about-to-be-stored) header and ACTIVE items onto the shape the domain
 * validations consume. Soft-removed items must never reach this function.
 */
export function toStoredDocumentFields(
  header: ReceivedDocumentHeader,
  items: readonly ReceivedDocumentItem[],
): ReceivedDocumentFields {
  const { establishmentCode, expeditionPointCode, documentNumber } = header;
  return {
    cdc: header.cdc,
    issuerRuc:
      header.issuerRucBase === null
        ? null
        : header.issuerRucDv === null
          ? header.issuerRucBase
          : `${header.issuerRucBase}-${String(header.issuerRucDv)}`,
    issuerLegalName: header.issuerLegalName,
    documentNumber:
      establishmentCode && expeditionPointCode && documentNumber
        ? `${establishmentCode}-${expeditionPointCode}-${documentNumber}`
        : null,
    issueDate: header.issuedAt === null ? null : header.issuedAt.toISOString().slice(0, 10),
    totals:
      header.totalAmount === null
        ? null
        : {
            exempt: header.totalExempt ?? ZERO,
            exonerated: header.totalZeroRated ?? ZERO,
            taxable5: header.taxable5 ?? ZERO,
            taxable10: header.taxable10 ?? ZERO,
            vat5: header.vat5 ?? ZERO,
            vat10: header.vat10 ?? ZERO,
            total: header.totalAmount,
          },
    itemAmounts: items.flatMap((item) => (item.subtotal === null ? [] : [item.subtotal])),
  };
}
