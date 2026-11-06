import type { ReceivedDocumentFields } from '../domain/received-document-validation.js';
import type { ParsedSifenDocument } from './ports/sifen-xml-parser.port.js';

/** Maps parser output onto the shape the domain validations consume. */
export function toReceivedDocumentFields(parsed: ParsedSifenDocument): ReceivedDocumentFields {
  const { issuer } = parsed;
  return {
    cdc: parsed.cdc,
    issuerRuc: issuer.dv === null ? issuer.ruc : `${issuer.ruc}-${issuer.dv}`,
    issuerLegalName: issuer.legalName,
    documentNumber: parsed.documentNumber,
    issueDate: parsed.issueDate,
    totals: parsed.totals,
    itemAmounts: parsed.items.map((item) => item.lineTotal),
  };
}
