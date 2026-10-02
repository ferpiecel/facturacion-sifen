import { describe, expect, it } from 'vitest';
import type { CycleReport } from '../modules/transmission/application/transmission-cycle.js';
import type { TenantRunLock } from './tenant-run-lock.js';
import { TransmissionCycleProcessor } from './transmission-cycle-processor.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const empty: CycleReport = {
  signed: 0,
  signSkipped: 0,
  sendSkipped: 0,
  assembled: 0,
  sent: [],
  polled: [],
  failures: [],
  held: [],
  stalePending: 0,
};

function setup(
  report: Partial<CycleReport> = {},
  options: { locked?: boolean; fail?: boolean } = {},
) {
  const events: string[] = [];
  const logs: { level: string; message: string }[] = [];
  const lock: TenantRunLock = {
    acquire: (tenantId) => {
      events.push(`acquire:${tenantId}`);
      return Promise.resolve(
        options.locked
          ? null
          : () => {
              events.push('release');
              return Promise.resolve();
            },
      );
    },
  };
  const processor = new TransmissionCycleProcessor({
    lock,
    createCycle: (tenantId) => ({
      run: () => {
        events.push(`run:${tenantId}`);
        return options.fail
          ? Promise.reject(new Error('db password=hunter2'))
          : Promise.resolve({ ...empty, ...report });
      },
    }),
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
  });
  return { processor, events, logs };
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
});
