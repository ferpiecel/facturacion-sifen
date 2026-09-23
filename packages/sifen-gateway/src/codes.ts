/**
 * Verified SIFEN response codes (`dCodRes`) this gateway and its fake
 * currently model. Sources: SIFEN Manual Técnico (MT) and the integration
 * guides (Guía) referenced in `docs/referencia/dnit/`.
 */
export const SIFEN_CODES = {
  /** Lote received and queued for processing. MT §12, Guía de Transmisión. */
  LOTE_RECIBIDO: '0300',
  /** Lote received but not queued (e.g. duplicate). MT §12. */
  LOTE_NO_ENCOLADO: '0301',
  /** Lote still being processed. MT §12, Guía de Consulta de Lote. */
  LOTE_EN_PROCESAMIENTO: '0361',
  /** Lote processing concluded; results available. MT §12. */
  LOTE_CONCLUIDO: '0362',
  /** Queried lote number does not exist. MT §12. */
  LOTE_INEXISTENTE: '0360',
  /** Lote query made outside the allowed consultation window. MT §12. */
  CONSULTA_EXTEMPORANEA: '0364',
  /** Synchronous DE authorized. MT §11, Guía de Transmisión Síncrona. */
  DE_AUTORIZADO: '0260',
  /** Queried CDC found. MT §13, Guía de Consulta de DE. */
  CDC_ENCONTRADO: '0422',
  /** Queried CDC not found or not permitted. MT §13. */
  CDC_INEXISTENTE: '0420',
  /** Submitted XML is malformed. MT §11. */
  XML_MALFORMADO: '0160',
} as const;

export type SifenCode = (typeof SIFEN_CODES)[keyof typeof SIFEN_CODES];
