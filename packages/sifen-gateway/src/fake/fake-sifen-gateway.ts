import type { SifenCall, SifenGateway, SifenOperation, SifenResultOf } from '../port.ts';
import { cdcInexistente, deAutorizado, loteInexistente, loteRecibido } from './scenarios.ts';

/** A response to script: a resolved value, or an `Error` to reject the call with. */
export type Scripted<T> = T | Error;

// Keyed by operation but intentionally untyped per-value: `SifenResultOf<K>` does not
// distribute cleanly over a generic mapped-type index, so the typed boundary lives in
// `enqueue`/`setDefault`/`respond` instead of in these internal maps.
type Queue = Partial<Record<SifenOperation, unknown[]>>;
type Defaults = Partial<Record<SifenOperation, unknown>>;

/**
 * Built-in defaults for the operations with a verified success/failure code
 * when the test scripts nothing. `enviarEventos` and `consultarRUC` have no
 * verified code, so they reject with "no response configured" instead.
 */
function builtInDefaults(): Defaults {
  return {
    enviarLote: loteRecibido('1'),
    consultarLote: loteInexistente(),
    enviarDESincronico: deAutorizado('1'),
    consultarDE: cdcInexistente(),
  };
}

const MIN_EVENTOS = 1;
const MAX_EVENTOS = 15;

/** Deterministic, scripted, in-process test double for `SifenGateway`. Never waits on real timers. */
export class FakeSifenGateway implements SifenGateway {
  private queue: Queue = {};
  private defaults: Defaults = builtInDefaults();
  private recordedCalls: SifenCall[] = [];

  enqueue<K extends SifenOperation>(op: K, ...responses: Scripted<SifenResultOf<K>>[]): this {
    const existing = this.queue[op] ?? [];
    this.queue[op] = [...existing, ...responses];
    return this;
  }

  setDefault<K extends SifenOperation>(op: K, response: Scripted<SifenResultOf<K>>): this {
    this.defaults[op] = response;
    return this;
  }

  get calls(): readonly SifenCall[] {
    return this.recordedCalls;
  }

  callsTo<K extends SifenOperation>(op: K): Parameters<SifenGateway[K]>[] {
    return this.recordedCalls
      .filter((call): call is Extract<SifenCall, { operation: K }> => call.operation === op)
      .map((call) => call.args as Parameters<SifenGateway[K]>);
  }

  reset(): void {
    this.queue = {};
    this.defaults = builtInDefaults();
    this.recordedCalls = [];
  }

  enviarLote(
    request: Parameters<SifenGateway['enviarLote']>[0],
  ): ReturnType<SifenGateway['enviarLote']> {
    return this.dispatch('enviarLote', [request]);
  }

  consultarLote(
    request: Parameters<SifenGateway['consultarLote']>[0],
  ): ReturnType<SifenGateway['consultarLote']> {
    return this.dispatch('consultarLote', [request]);
  }

  enviarDESincronico(
    request: Parameters<SifenGateway['enviarDESincronico']>[0],
  ): ReturnType<SifenGateway['enviarDESincronico']> {
    return this.dispatch('enviarDESincronico', [request]);
  }

  consultarDE(
    request: Parameters<SifenGateway['consultarDE']>[0],
  ): ReturnType<SifenGateway['consultarDE']> {
    return this.dispatch('consultarDE', [request]);
  }

  consultarRUC(
    request: Parameters<SifenGateway['consultarRUC']>[0],
  ): ReturnType<SifenGateway['consultarRUC']> {
    return this.dispatch('consultarRUC', [request]);
  }

  enviarEventos(
    request: Parameters<SifenGateway['enviarEventos']>[0],
  ): ReturnType<SifenGateway['enviarEventos']> {
    this.record('enviarEventos', [request]);

    if (request.eventos.length < MIN_EVENTOS || request.eventos.length > MAX_EVENTOS) {
      return Promise.reject(
        new RangeError(
          `enviarEventos accepts 1 to 15 events, received ${String(request.eventos.length)}`,
        ),
      );
    }

    return this.respond('enviarEventos');
  }

  private dispatch<K extends SifenOperation>(
    op: K,
    args: Parameters<SifenGateway[K]>,
  ): Promise<SifenResultOf<K>> {
    this.record(op, args);
    return this.respond(op);
  }

  private respond<K extends SifenOperation>(op: K): Promise<SifenResultOf<K>> {
    const queued = this.queue[op]?.shift();
    const response = (queued ?? this.defaults[op]) as Scripted<SifenResultOf<K>> | undefined;

    if (response === undefined) {
      return Promise.reject(new Error(`No response configured for SIFEN operation "${op}"`));
    }

    if (response instanceof Error) {
      return Promise.reject(response);
    }

    return Promise.resolve(response);
  }

  private record<K extends SifenOperation>(operation: K, args: Parameters<SifenGateway[K]>): void {
    this.recordedCalls = [
      ...this.recordedCalls,
      { operation, args: structuredClone(args) } as SifenCall,
    ];
  }
}
