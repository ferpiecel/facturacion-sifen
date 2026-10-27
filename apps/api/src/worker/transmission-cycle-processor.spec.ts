import { describe, expect, it } from 'vitest';
import type { CycleReport } from '../modules/transmission/application/transmission-cycle.js';
import type { Telemetry } from '../modules/telemetry/application/ports/telemetry.port.js';
import { NOOP_TELEMETRY } from '../modules/telemetry/infrastructure/noop-telemetry.js';
import type { TenantRunLock } from './tenant-run-lock.js';
import { TransmissionCycleProcessor } from './transmission-cycle-processor.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const empty: CycleReport = {
  signed: 0,
  signSkipped: 0,
  sendSkipped: 0,
  sendDeferred: 0,
  rucBlocks: 0,
  sendPausedUntil: null,
  assembled: 0,
  sent: [],
  polled: [],
  recovered: [],
  sweptSending: 0,
  failures: [],
  held: [],
  stalePending: 0,
};

const lease = new AbortController();

function recordingTelemetry(spans: string[] = []) {
  const metrics: string[] = [];
  const telemetry: Telemetry = {
    ...NOOP_TELEMETRY,
    increment: (name, by = 1) => void metrics.push(`${name}:${String(by)}`),
    withSpan: (name, attributes, fn, traceparent) => {
      spans.push(
        `${name} tenant.id=${String(attributes['tenant.id'])} parent=${traceparent ?? 'root'}`,
      );
      return fn({ traceId: '' });
    },
  };
  return { telemetry, metrics };
}

function setup(
  report: Partial<CycleReport> = {},
  options: {
    locked?: boolean;
    fail?: boolean;
    telemetry?: Telemetry;
  } = {},
) {
  const clock = { now: 0 };
  const received: (AbortSignal | undefined)[] = [];
  const events: string[] = [];
  const logs: { level: string; message: string }[] = [];
  const lock: TenantRunLock = {
    acquire: (tenantId) => {
      events.push(`acquire:${tenantId}`);
      return Promise.resolve(
        options.locked
          ? null
          : {
              signal: lease.signal,
              release: () => {
                events.push('release');
                return Promise.resolve();
              },
            },
      );
    },
  };
  const processor = new TransmissionCycleProcessor({
    lock,
    createCycle: (tenantId) => ({
      run: ({ signal }: { signal?: AbortSignal } = {}) => {
        received.push(signal);
        events.push(`run:${tenantId}`);
        return options.fail
          ? Promise.reject(new Error('db password=hunter2'))
          : Promise.resolve({ ...empty, ...report });
      },
    }),
    now: () => new Date(clock.now),
    heldListEveryMs: 600_000,
    telemetry: options.telemetry,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
  });
  return { processor, events, logs, clock, received };
}

/** Spec: HU-E6-02 (S5e). The job handler of the per-tenant transmission cycle. */
describe('TransmissionCycleProcessor', () => {
  it('runs the tenant cycle under the tenant lock and releases it', async () => {
    const { processor, events } = setup();

    expect(await processor.process({ tenantId: TENANT })).toEqual({ status: 'done' });
    expect(events).toEqual([`acquire:${TENANT}`, `run:${TENANT}`, 'release']);
  });

  it('skips the run when the tenant is already being processed', async () => {
    const { processor, events, logs } = setup({}, { locked: true });

    expect(await processor.process({ tenantId: TENANT })).toEqual({ status: 'skipped' });
    expect(events).toEqual([`acquire:${TENANT}`]);
    expect(logs.at(0)?.level).toBe('info');
  });

  it('rejects a job without a valid tenant id before touching the lock', async () => {
    const { processor, events } = setup();

    await expect(processor.process({ tenantId: "x'; drop table tenants" })).rejects.toThrow(
      'invalid tenant id',
    );
    await expect(processor.process({})).rejects.toThrow('invalid tenant id');
    expect(events).toEqual([]);
  });

  it('logs how many lotes were polled and recovered', async () => {
    const { processor, logs } = setup({
      polled: [
        { loteId: 'l1', status: 'pending' },
        { loteId: 'l2', status: 'processed' },
      ],
      recovered: [{ loteId: 'l3', status: 'recovered' }],
      sweptSending: 3,
    });
    await processor.process({ tenantId: TENANT });
    expect(logs[0].message).toContain('polled=2 recovered=1 swept=3');
  });

  it('reports the lotes left pending by an open circuit in the cycle summary', async () => {
    const { processor, logs } = setup({ sendDeferred: 2 });
    await processor.process({ tenantId: TENANT });
    expect(logs[0].message).toContain('deferred=2');
  });

  describe('tracing (HU-E14-01)', () => {
    it('runs the cycle in a span that continues the job traceparent and carries the tenant', async () => {
      const spans: string[] = [];
      const { telemetry } = recordingTelemetry(spans);
      const { processor } = setup({}, { telemetry });
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      await processor.process({ tenantId: TENANT, traceparent });
      expect(spans).toEqual([`transmission.cycle tenant.id=${TENANT} parent=${traceparent}`]);
    });

    it('starts a root trace when the job carries no traceparent, and marks a failure', async () => {
      const spans: string[] = [];
      const { telemetry } = recordingTelemetry(spans);
      const { processor } = setup({}, { telemetry, fail: true });
      await expect(processor.process({ tenantId: TENANT })).rejects.toThrow();
      expect(spans).toEqual([`transmission.cycle tenant.id=${TENANT} parent=root`]);
    });
  });

  describe('RUC block alert and metric (HU-E6-05)', () => {
    it('raises an error-level alert and counts the block when a lote made SIFEN block the RUC', async () => {
      const { telemetry, metrics } = recordingTelemetry();
      const { processor, logs } = setup(
        { rucBlocks: 1, sendPausedUntil: new Date('2026-10-02T12:30:00Z') },
        { telemetry },
      );
      await processor.process({ tenantId: TENANT });
      const alert = logs.find((log) => log.level === 'error');
      expect(alert?.message).toContain(`tenant ${TENANT} RUC blocked`);
      expect(alert?.message).toContain('2026-10-02T12:30:00.000Z');
      expect(metrics).toEqual(['sifen_ruc_blocks_total:1']);
    });

    it('only warns while an earlier pause lasts, without counting it again', async () => {
      const { telemetry, metrics } = recordingTelemetry();
      const { processor, logs } = setup(
        { sendPausedUntil: new Date('2026-10-02T12:30:00Z') },
        { telemetry },
      );
      await processor.process({ tenantId: TENANT });
      expect(logs.filter((log) => log.level === 'error')).toEqual([]);
      expect(logs.some((log) => log.message.includes('sends paused until'))).toBe(true);
      expect(metrics).toEqual([]);
    });
  });

  it('logs a quiet summary, and warnings for held documents, stale lotes and failures', async () => {
    const quiet = setup({ signed: 2, sent: [{ loteId: 'l1', status: 'sent' }] });
    await quiet.processor.process({ tenantId: TENANT });
    expect(quiet.logs).toHaveLength(1);
    expect(quiet.logs[0]).toMatchObject({ level: 'info' });
    expect(quiet.logs[0].message).toContain('signed=2');
    expect(quiet.logs[0].message).toContain('sent=1');

    const noisy = setup({
      held: [{ documentId: 'd1', reason: 'signing:CscNotConfiguredError' }],
      stalePending: 3,
      failures: [{ step: 'send', id: 'l9', error: 'SifenTimeoutError' }],
    });
    await noisy.processor.process({ tenantId: TENANT });
    const warnings = noisy.logs.filter((log) => log.level === 'warn').map((log) => log.message);
    expect(warnings.join('\n')).toContain('held=1');
    expect(warnings.join('\n')).toContain('d1 signing:CscNotConfiguredError');
    expect(warnings.join('\n')).toContain('stalePending=3');
    expect(warnings.join('\n')).toContain('send l9 SifenTimeoutError');
  });

  it('releases the lock and logs only the error class when the cycle throws', async () => {
    const { processor, events, logs } = setup({}, { fail: true });

    await expect(processor.process({ tenantId: TENANT })).rejects.toThrow();
    expect(events.at(-1)).toBe('release');
    expect(logs.map((log) => log.message).join('\n')).not.toContain('hunter2');
    expect(logs.at(-1)).toMatchObject({ level: 'error' });
  });

  it('runs the cycle with the lease signal and warns when the run lock was lost mid-cycle', async () => {
    const { processor, logs, received } = setup({ aborted: true });

    await processor.process({ tenantId: TENANT });

    expect(received).toEqual([lease.signal]);
    expect(logs.filter((log) => log.level === 'warn').map((log) => log.message)).toEqual([
      expect.stringContaining('lost the run lock'),
    ]);
  });

  it('logs the held count every cycle but the id list only every N minutes and at most 10 ids', async () => {
    const held = Array.from({ length: 12 }, (_, i) => ({
      documentId: `d${String(i + 1)}`,
      reason: 'signing:CscNotConfiguredError',
    }));
    const { processor, logs, clock } = setup({ held });
    const warnings = () => logs.splice(0).filter((log) => log.level === 'warn');

    await processor.process({ tenantId: TENANT });
    const first = warnings()
      .map((log) => log.message)
      .join('\n');
    expect(first).toContain('held=12');
    expect(first).toContain('d10 signing:CscNotConfiguredError');
    expect(first).not.toContain('d11');

    clock.now += 60_000;
    await processor.process({ tenantId: TENANT });
    const quiet = warnings()
      .map((log) => log.message)
      .join('\n');
    expect(quiet).toContain('held=12');
    expect(quiet).not.toContain('d1 ');

    clock.now += 600_000;
    await processor.process({ tenantId: TENANT });
    expect(
      warnings()
        .map((log) => log.message)
        .join('\n'),
    ).toContain('d1 signing');
  });
});
