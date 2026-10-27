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
  /** Evento registrado correctamente (siRecepEvento, MT v150 BU01). */
  EVENTO_REGISTRADO: '0600',
  /** Autorización del DE satisfactoria (siRecepDE, synchronous). */
  DE_AUTORIZADO: '0260',
  /** RUC not enabled for the synchronous service (siRecepDE, MT validation 1264; ADR-0007). */
  RUC_NO_HABILITADO_SINCRONICO: '1264',
  /**
   * siConsDE codes follow MT v150 §9.4.2 Tabla G. MT §12.3.4.3 contradicts it by
   * listing 0421 as "CDC encontrado"; per ADR-0012 this stays pending confirmation
   * in sifen-test.
   */
  /** CDC encontrado (siConsDE, Tabla G). */
  CDC_ENCONTRADO: '0422',
  /** CDC inexistente (siConsDE). */
  CDC_INEXISTENTE: '0420',
  /** RUC del certificado sin permiso para consultar el DE (siConsDE, Tabla G). */
  RUC_CERTIFICADO_SIN_PERMISO: '0421',
  /** RUC consultado inexistente (siConsRUC, MT v150 Tabla H). */
  RUC_INEXISTENTE: '0500',
  /** El certificado no tiene permiso para usar el WS de consulta RUC (siConsRUC, Tabla H). */
  RUC_SIN_PERMISO: '0501',
  /** RUC encontrado (siConsRUC, Tabla H). */
  RUC_ENCONTRADO: '0502',
  /** XML malformado (generic input validation). */
  XML_MALFORMADO: '0160',
} as const;

export type SifenCode = (typeof SIFEN_CODES)[keyof typeof SIFEN_CODES];
