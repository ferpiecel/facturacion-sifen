/**
 * The only metrics the system emits (plan v1.1 §13 plus transport and circuit signals). Each one
 * names the label keys it may carry: anything else is dropped by the adapter, so a tenant id, a CDC,
 * a URL or free text can never become a label (cardinality and PII, HU-E14-01 D3).
 */
export type MetricKind = 'counter' | 'histogram' | 'gauge';

export interface MetricDefinition {
  readonly kind: MetricKind;
  readonly description: string;
  readonly labels: readonly string[];
}

export const METRIC_CATALOG = {
  sifen_lote_status_total: {
    kind: 'counter',
    description: 'Lote results by SIFEN code (0300, 0301, 0361, 0362, 0364)',
    labels: ['codigo'],
  },
  sifen_rejections_total: {
    kind: 'counter',
    description: 'Documents rejected by SIFEN, by response code',
    labels: ['codigo'],
  },
  sifen_ruc_blocks_total: {
    kind: 'counter',
    description: 'RUC blocks reported by SIFEN (code 0160-class responses)',
    labels: [],
  },
  sifen_request_errors_total: {
    kind: 'counter',
    description: 'SIFEN calls that failed in transport or returned an error',
    labels: ['operation', 'outcome'],
  },
  sifen_lote_processing_seconds: {
    kind: 'histogram',
    description: 'Seconds from sending a lote to its final result',
    labels: [],
  },
  sifen_request_seconds: {
    kind: 'histogram',
    description: 'Latency of SIFEN calls',
    labels: ['operation'],
  },
  sifen_circuit_state: {
    kind: 'gauge',
    description: 'Circuit breaker state per SIFEN operation (0 closed, 1 half-open, 2 open)',
    labels: ['operation'],
  },
  de_pending_transmission: {
    kind: 'gauge',
    description: 'Documents not yet approved by age bucket (<24h, 24-48h, 48-72h, >72h)',
    labels: ['bucket'],
  },
  sifen_ruc_blocked_tenants: {
    kind: 'gauge',
    description: 'Tenants whose sends are paused by a RUC block',
    labels: [],
  },
  certificate_expiry_days_min: {
    kind: 'gauge',
    description: 'Days until the soonest certificate expiry across tenants',
    labels: [],
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRIC_CATALOG;
export type Labels = Readonly<Record<string, string | number>>;

/** Keeps only the label keys the metric declares. */
export function allowedLabels(name: MetricName, labels: Labels | undefined): Labels {
  const allowed: readonly string[] = METRIC_CATALOG[name].labels;
  return Object.fromEntries(Object.entries(labels ?? {}).filter(([key]) => allowed.includes(key)));
}
