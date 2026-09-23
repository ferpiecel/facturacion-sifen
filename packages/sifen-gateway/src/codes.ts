/**
 * Verified SIFEN response codes (`dCodRes`) this gateway and its fake model.
 * Meanings come from the Manual Técnico v150 (MT) and the Guía de Mejores
 * Prácticas para la Gestión del Envío de DE (Oct/2024) in `docs/referencia/dnit/`.
 */
export const SIFEN_CODES = {
  /** Lote recibido con éxito (siRecepLoteDE). */
  LOTE_RECIBIDO: '0300',
  /** Lote no encolado para procesamiento; SIFEN will not process it (siRecepLoteDE). */
  LOTE_NO_ENCOLADO: '0301',
  /** Número de lote inexistente (siResultLoteDE). */
  LOTE_INEXISTENTE: '0360',
  /** Lote en procesamiento (siResultLoteDE). */
  LOTE_EN_PROCESAMIENTO: '0361',
  /** Procesamiento de lote concluido; per-DE results are included (siResultLoteDE). */
  LOTE_CONCLUIDO: '0362',
  /** Consulta extemporánea: lotes can be queried up to 48 h after sending (siResultLoteDE). */
  CONSULTA_EXTEMPORANEA: '0364',
  /** Autorización del DE satisfactoria (siRecepDE, synchronous). */
  DE_AUTORIZADO: '0260',
  /** CDC encontrado (siConsDE). */
  CDC_ENCONTRADO: '0422',
  /** CDC inexistente, also returned when the certificate RUC lacks permission (siConsDE). */
  CDC_INEXISTENTE: '0420',
  /** XML malformado (generic input validation). */
  XML_MALFORMADO: '0160',
} as const;

export type SifenCode = (typeof SIFEN_CODES)[keyof typeof SIFEN_CODES];
