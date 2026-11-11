import {
  SifenTenantUnavailableError,
  SifenTimeoutError,
  SifenTransportError,
  type SifenGateway,
  type SifenOperation,
  type SifenResultOf,
} from '@sifen/sifen-gateway';
import type { Telemetry } from '../modules/telemetry/application/ports/telemetry.port.js';

const OPERATIONS: readonly SifenOperation[] = [
  'enviarLote',
  'consultarLote',
  'enviarDESincronico',
  'consultarDE',
  'enviarEventos',
  'consultarRUC',
];

const REJECTED = 'Rechazado';

/** Only a 4-digit SIFEN code may become a label; anything else is bucketed (cardinality, no free text). */
function code(value: unknown): string {
  return typeof value === 'string' && /^\d{4}$/.test(value) ? value : 'other';
}

function outcome(error: unknown): string {
  if (error instanceof SifenTenantUnavailableError) return 'tenant_unavailable';
  if (error instanceof SifenTimeoutError) return 'timeout';
  if (error instanceof SifenTransportError) return 'transport';
  return 'error';
}

interface Responded {
  dCodRes?: unknown;
  dEstRes?: unknown;
  resultados?: { dEstRes?: unknown; mensajes?: { dCodRes?: unknown }[] }[];
}

function countResponse(telemetry: Telemetry, operation: SifenOperation, response: Responded): void {
  if (operation === 'enviarLote' || operation === 'consultarLote') {
    telemetry.increment('sifen_lote_status_total', 1, { codigo: code(response.dCodRes) });
  }
  if (operation === 'enviarDESincronico' && response.dEstRes === REJECTED) {
    telemetry.increment('sifen_rejections_total', 1, { codigo: code(response.dCodRes) });
  }
  for (const result of response.resultados ?? []) {
    if (result.dEstRes === REJECTED) {
      telemetry.increment('sifen_rejections_total', 1, {
        codigo: code(result.mensajes?.[0]?.dCodRes),
      });
    }
  }
}

/**
 * Decorates the SIFEN gateway (HU-E14-01): one span per call, its latency, the lote and rejection
 * response codes and the failures by class. Wraps the inner gateway, under the circuit breaker, so a
 * short-circuited call never counts as a SIFEN call. Spans and labels carry operation names and
 * codes only, never XML, CDCs, tenants or URLs.
 */
export function withTelemetry(inner: SifenGateway, telemetry: Telemetry): SifenGateway {
  const wrapped = {} as Record<SifenOperation, (request: never) => Promise<unknown>>;
  for (const operation of OPERATIONS) {
    wrapped[operation] = (request) =>
      telemetry.withSpan(`sifen.${operation}`, { operation }, async () => {
        const startedAt = performance.now();
        let reachedSifen = true;
        try {
          const response = (await (
            inner[operation] as (r: never) => Promise<SifenResultOf<typeof operation>>
          )(request)) as Responded;
          countResponse(telemetry, operation, response);
          return response;
        } catch (error) {
          // The call never left the process (no certificate, production off): no SIFEN latency.
          reachedSifen = !(error instanceof SifenTenantUnavailableError);
          telemetry.increment('sifen_request_errors_total', 1, {
            operation,
            outcome: outcome(error),
          });
          throw error;
        } finally {
          if (reachedSifen) {
            telemetry.observe('sifen_request_seconds', (performance.now() - startedAt) / 1000, {
              operation,
            });
          }
        }
      });
  }
  return wrapped as unknown as SifenGateway;
}
