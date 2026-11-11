import { SIFEN_CODES } from '../codes.ts';
import type {
  SifenConsDE,
  SifenConsRUC,
  SifenContribuyente,
  SifenEventosResult,
  SifenResultadoEvento,
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
export function cdcEncontrado(xmlDE: string, eventos: readonly string[] = []): SifenConsDE {
  return {
    dCodRes: SIFEN_CODES.CDC_ENCONTRADO,
    dMsgRes: 'CDC encontrado',
    xmlDE,
    eventos: [...eventos],
  };
}

/** Builds a `siConsDE` "CDC inexistente" (0420) response. */
export function cdcInexistente(): SifenConsDE {
  return {
    dCodRes: SIFEN_CODES.CDC_INEXISTENTE,
    dMsgRes: 'CDC inexistente',
    xmlDE: null,
    eventos: [],
  };
}

/** Builds a `siConsDE` "RUC del certificado sin permiso" (0421) response, per MT Tabla G. */
export function rucCertificadoSinPermiso(): SifenConsDE {
  return {
    dCodRes: SIFEN_CODES.RUC_CERTIFICADO_SIN_PERMISO,
    dMsgRes: 'RUC del certificado sin permiso para consultar el DE',
    xmlDE: null,
    eventos: [],
  };
}

/**
 * Builds a `siRecepEvento` response with one result per event. The schema has no lote-level code, so the
 * headline is the first message of the first result (as `parseEventos` does).
 */
export function eventosProcesados(resultados: readonly SifenResultadoEvento[]): SifenEventosResult {
  const first = resultados.at(0)?.mensajes.at(0);
  return {
    dCodRes: first?.dCodRes ?? SIFEN_CODES.EVENTO_REGISTRADO,
    dMsgRes: first?.dMsgRes ?? 'Evento registrado correctamente',
    resultados: [...resultados],
  };
}

/** Builds a `siConsRUC` "RUC encontrado" (0502) response. */
export function rucEncontrado(contribuyente: SifenContribuyente): SifenConsRUC {
  return {
    dCodRes: SIFEN_CODES.RUC_ENCONTRADO,
    dMsgRes: 'RUC encontrado',
    contribuyente: { ...contribuyente },
  };
}

/** Builds a `siConsRUC` "RUC no existe" (0500) response. */
export function rucInexistente(): SifenConsRUC {
  return { dCodRes: SIFEN_CODES.RUC_INEXISTENTE, dMsgRes: 'RUC no existe', contribuyente: null };
}

/** Builds a `siConsRUC` "RUC sin permiso consulta WS" (0501) response. */
export function rucSinPermisoConsulta(): SifenConsRUC {
  return {
    dCodRes: SIFEN_CODES.RUC_SIN_PERMISO,
    dMsgRes: 'RUC sin permiso consulta WS',
    contribuyente: null,
  };
}
