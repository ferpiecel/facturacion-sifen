import { SIFEN_CODES } from '../codes.ts';
import type {
  SifenConsDE,
  SifenLoteReceipt,
  SifenLoteResult,
  SifenProtocoloDE,
  SifenResultadoDE,
} from '../types.ts';

/** Builds a `siRecepLoteDE` "lote recibido" (0300) response. */
export function loteRecibido(dProtConsLote: string): SifenLoteReceipt {
  return { dCodRes: SIFEN_CODES.LOTE_RECIBIDO, dMsgRes: 'Lote recibido con éxito', dProtConsLote };
}

/** Builds a `siRecepLoteDE` "lote no encolado" (0301) response. */
export function loteNoEncolado(dMsgRes: string): SifenLoteReceipt {
  return { dCodRes: SIFEN_CODES.LOTE_NO_ENCOLADO, dMsgRes, dProtConsLote: null };
}

/** Builds a `siResultLoteDE` "número de lote inexistente" (0360) response. */
export function loteInexistente(): SifenLoteResult {
  return {
    dCodRes: SIFEN_CODES.LOTE_INEXISTENTE,
    dMsgRes: 'Número de lote inexistente',
    resultados: [],
  };
}

/** Builds a `siResultLoteDE` "lote en procesamiento" (0361) response. */
export function loteEnProcesamiento(): SifenLoteResult {
  return {
    dCodRes: SIFEN_CODES.LOTE_EN_PROCESAMIENTO,
    dMsgRes: 'Lote en procesamiento',
    resultados: [],
  };
}

/** Builds a `siResultLoteDE` "procesamiento concluido" (0362) response. */
export function loteConcluido(resultados: readonly SifenResultadoDE[] = []): SifenLoteResult {
  return {
    dCodRes: SIFEN_CODES.LOTE_CONCLUIDO,
    dMsgRes: 'Procesamiento de lote concluido',
    resultados: [...resultados],
  };
}

/** Builds a `siResultLoteDE` "consulta extemporánea" (0364) response. */
export function consultaExtemporanea(): SifenLoteResult {
  return {
    dCodRes: SIFEN_CODES.CONSULTA_EXTEMPORANEA,
    dMsgRes: 'Consulta extemporánea',
    resultados: [],
  };
}

/** Builds a `siRecepDE` "autorización satisfactoria" (0260) response. */
export function deAutorizado(dProtAut: string): SifenProtocoloDE {
  return {
    dCodRes: SIFEN_CODES.DE_AUTORIZADO,
    dMsgRes: 'Autorización del DE satisfactoria',
    dEstRes: 'Aprobado',
    dProtAut,
  };
}

/** Builds a `siConsDE` "CDC encontrado" (0422) response. */
export function cdcEncontrado(xmlDE: string): SifenConsDE {
  return { dCodRes: SIFEN_CODES.CDC_ENCONTRADO, dMsgRes: 'CDC encontrado', xmlDE };
}

/** Builds a `siConsDE` "CDC inexistente" (0420) response. */
export function cdcInexistente(): SifenConsDE {
  return { dCodRes: SIFEN_CODES.CDC_INEXISTENTE, dMsgRes: 'CDC inexistente', xmlDE: null };
}

/** Builds a `siConsDE` "RUC del certificado sin permiso" (0421) response, per MT Tabla G. */
export function rucCertificadoSinPermiso(): SifenConsDE {
  return {
    dCodRes: SIFEN_CODES.RUC_CERTIFICADO_SIN_PERMISO,
    dMsgRes: 'RUC del certificado sin permiso para consultar el DE',
    xmlDE: null,
  };
}
