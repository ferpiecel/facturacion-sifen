import type { SifenCode } from './codes.ts';

declare const cdcBrand: unique symbol;

/** A validated 44-digit Código de Control (CDC). */
export type Cdc = string & { readonly [cdcBrand]: true };

const CDC_PATTERN = /^\d{44}$/;

/** Validates and brands a CDC. Throws `RangeError` when the value is not exactly 44 digits. */
export function toCdc(value: string): Cdc {
  if (!CDC_PATTERN.test(value)) {
    throw new RangeError(`Invalid CDC: expected 44 digits, received "${value}"`);
  }

  return value as Cdc;
}

/** Base shape of every SIFEN response. */
export interface SifenRespuesta {
  dCodRes: SifenCode | (string & {});
  dMsgRes: string;
}

export interface SifenResultadoDE {
  cdc: Cdc;
  dEstRes: string;
  mensajes: SifenRespuesta[];
}

export interface SifenLoteReceipt extends SifenRespuesta {
  dProtConsLote: string | null;
}

export interface SifenLoteResult extends SifenRespuesta {
  resultados: SifenResultadoDE[];
}

export interface SifenProtocoloDE extends SifenRespuesta {
  dEstRes: string | null;
  dProtAut: string | null;
}

export interface SifenConsDE extends SifenRespuesta {
  xmlDE: string | null;
}

export interface SifenResultadoEvento {
  id: string;
  dEstRes: string;
  mensajes: SifenRespuesta[];
}

export interface SifenEventosResult extends SifenRespuesta {
  resultados: SifenResultadoEvento[];
}

export interface SifenContribuyente {
  ruc: string;
  razonSocial: string;
  estado: string;
  facturadorElectronico: boolean;
}

export interface SifenConsRUC extends SifenRespuesta {
  contribuyente: SifenContribuyente | null;
}
