import type { SifenCall, SifenGateway, SifenOperation, SifenResultOf } from '../port.ts';
import { cdcInexistente, deAutorizado, loteInexistente, loteRecibido } from './scenarios.ts';

/** A response to script: a resolved value, or an `Error` to reject the call with. */
export type Scripted<T> = T | Error;

type Req<K extends SifenOperation> = Parameters<SifenGateway[K]>[0];

// Untyped per-value on purpose: `SifenResultOf<K>` does not distribute over a generic
// mapped-type index. The typed boundary lives in `enqueue`/`setDefault`/`respond`.
type Queue = Partial<Record<SifenOperation, unknown[]>>;
type Defaults = Partial<Record<SifenOperation, unknown>>;

/** Built-in defaults when nothing is scripted. `enviarEventos`/`consultarRUC` have no verified code. */
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

/** Copies scripted results so callers cannot mutate them after scripting; errors keep their identity. */
function snapshot<T>(response: Scripted<T>): Scripted<T> {
  return response instanceof Error ? response : structuredClone(response);
}

/** Deterministic, scripted, in-process test double for `SifenGateway`. Never waits on real timers. */
export class FakeSifenGateway implements SifenGateway {
  private queue: Queue = {};
  private defaults: Defaults = builtInDefaults();
  private recordedCalls: SifenCall[] = [];

  enqueue<K extends SifenOperation>(op: K, ...responses: Scripted<SifenResultOf<K>>[]): this {
    const existing = this.queue[op] ?? [];
    this.queue[op] = [...existing, ...responses.map(snapshot)];
    return this;
  }

  setDefault<K extends SifenOperation>(op: K, response: Scripted<SifenResultOf<K>>): this {
    this.defaults[op] = snapshot(response);
    return this;
  }

  get calls(): readonly SifenCall[] {
    return [...this.recordedCalls];
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

  enviarLote(request: Req<'enviarLote'>) {
    return this.dispatch('enviarLote', [request]);
  }

  consultarLote(request: Req<'consultarLote'>) {
    return this.dispatch('consultarLote', [request]);
  }

  enviarDESincronico(request: Req<'enviarDESincronico'>) {
    return this.dispatch('enviarDESincronico', [request]);
  }

  consultarDE(request: Req<'consultarDE'>) {
    return this.dispatch('consultarDE', [request]);
  }

  consultarRUC(request: Req<'consultarRUC'>) {
    return this.dispatch('consultarRUC', [request]);
  }

  enviarEventos(request: Req<'enviarEventos'>) {
    this.record('enviarEventos', [request]);

    if (request.eventos.length < MIN_EVENTOS || request.eventos.length > MAX_EVENTOS) {
      const count = String(request.eventos.length);
      return Promise.reject(
        new RangeError(`enviarEventos accepts 1 to 15 events, received ${count}`),
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

    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(structuredClone(response));
  }

  private record<K extends SifenOperation>(operation: K, args: Parameters<SifenGateway[K]>): void {
    this.recordedCalls = [
      ...this.recordedCalls,
      { operation, args: structuredClone(args) } as SifenCall,
    ];
  }
}
