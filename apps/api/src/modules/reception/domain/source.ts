/** How a received document entered the system. `manual` has no creator yet and is not a source. */
export const RECEIVED_DOCUMENT_SOURCES = ['sifen_xml', 'ekuatia_cdc', 'pdf', 'photo'] as const;

export type ReceivedDocumentSource = (typeof RECEIVED_DOCUMENT_SOURCES)[number];

export function isReceivedDocumentSource(value: unknown): value is ReceivedDocumentSource {
  return (
    typeof value === 'string' && (RECEIVED_DOCUMENT_SOURCES as readonly string[]).includes(value)
  );
}
