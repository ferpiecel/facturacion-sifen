export { SIFEN_CODES } from './codes.ts';
export type { SifenCode } from './codes.ts';
export { SifenTimeoutError, SifenTransportError } from './errors.ts';
export { FakeSifenGateway } from './fake/fake-sifen-gateway.ts';
export type { Scripted } from './fake/fake-sifen-gateway.ts';
export * as sifenScenarios from './fake/scenarios.ts';
export type { SifenCall, SifenGateway, SifenOperation, SifenResultOf } from './port.ts';
export { toCdc } from './types.ts';
export type {
  Cdc,
  SifenConsDE,
  SifenConsRUC,
  SifenContribuyente,
  SifenEventosResult,
  SifenLoteReceipt,
  SifenLoteResult,
  SifenProtocoloDE,
  SifenResultadoDE,
  SifenResultadoEvento,
  SifenRespuesta,
} from './types.ts';
