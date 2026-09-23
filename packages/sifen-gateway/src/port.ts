import type {
  Cdc,
  SifenConsDE,
  SifenConsRUC,
  SifenEventosResult,
  SifenLoteReceipt,
  SifenLoteResult,
  SifenProtocoloDE,
} from './types.ts';

/** Framework-free port to the SIFEN web services. Implementations MUST NOT import NestJS, Fastify, Drizzle, or BullMQ. */
export interface SifenGateway {
  /** Sends a lote (batch) of DEs for asynchronous processing. */
  enviarLote(request: { dId: bigint; des: readonly string[] }): Promise<SifenLoteReceipt>;

  /** Queries the processing result of a previously sent lote. */
  consultarLote(request: { dId: bigint; dProtConsLote: string }): Promise<SifenLoteResult>;

  /** Sends a single DE for synchronous authorization. */
  enviarDESincronico(request: { dId: bigint; de: string }): Promise<SifenProtocoloDE>;

  /** Queries a DE by its CDC. */
  consultarDE(request: { dId: bigint; cdc: Cdc }): Promise<SifenConsDE>;

  /** Sends a batch of events (e.g. cancelación, inutilización) for a DE. Limited to 15 events per call. */
  enviarEventos(request: { dId: bigint; eventos: readonly string[] }): Promise<SifenEventosResult>;

  /** Queries the RUC registry status for a taxpayer. */
  consultarRUC(request: { dId: bigint; ruc: string }): Promise<SifenConsRUC>;
}

export type SifenOperation = keyof SifenGateway;

export type SifenResultOf<K extends SifenOperation> = Awaited<ReturnType<SifenGateway[K]>>;

export type SifenCall = {
  [K in SifenOperation]: { operation: K; args: Parameters<SifenGateway[K]> };
}[SifenOperation];
