import { InvalidTenantIdError } from '@sifen/db';
import { describe, expect, it, vi } from 'vitest';
import type {
  LookupCdcDocumentInput,
  LookupCdcDocumentResult,
} from '../modules/reception/application/lookup-cdc-document.js';
import {
  RECEPTION_EKUATIA_LOOKUP_QUEUE,
  createReceptionEkuatiaProcessor,
} from './reception-ekuatia.processor.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CDC = '01444444017001001001452822017012515873260988';
const document = { id: '22222222-2222-4222-8222-222222222222', status: 'confirmed' } as never;

const job = (data: Partial<{ tenantId: string; cdc: string; usageDate: string }> = {}) => ({
  data: { tenantId: TENANT, cdc: CDC, usageDate: '2026-11-16', ...data },
});

function setup(result: LookupCdcDocumentResult | Error) {
  const execute = vi.fn<(input: LookupCdcDocumentInput) => Promise<LookupCdcDocumentResult>>(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const logger = { info: vi.fn(), warn: vi.fn() };
  const process = createReceptionEkuatiaProcessor({ lookup: { execute }, logger });
  return { execute, logger, process };
}

describe('reception eKuatia lookup processor', () => {
  it('names its queue after the job', () => {
    expect(RECEPTION_EKUATIA_LOOKUP_QUEUE).toBe('reception-ekuatia-lookup');
  });

  it('hands the job data to the use case', async () => {
    const { process, execute } = setup({ kind: 'ingested', document, created: true });
    await process(job());
    expect(execute).toHaveBeenCalledWith({ tenantId: TENANT, cdc: CDC, usageDate: '2026-11-16' });
  });

  it.each([
    [{ kind: 'ingested', document, created: true } as const, 'ingested:confirmed'],
    [{ kind: 'ingested', document, created: false } as const, 'ingested:existing'],
    [{ kind: 'skipped', reason: 'circuit_open' } as const, 'skipped:circuit_open'],
    [{ kind: 'skipped', reason: 'already_exists' } as const, 'skipped:already_exists'],
    [
      { kind: 'failed', code: 'captcha_balance_exhausted' } as const,
      'failed:captcha_balance_exhausted',
    ],
    [{ kind: 'failed', code: 'ekuatia_not_found' } as const, 'failed:ekuatia_not_found'],
  ])(
    'completes the job with the outcome %j -> %s (no retry, it would spend again)',
    async (result, outcome) => {
      const { process } = setup(result);
      expect(await process(job())).toEqual({ outcome });
    },
  );

  it('logs ids and stable codes only, never the CDC', async () => {
    const { process, logger } = setup({ kind: 'failed', code: 'ekuatia_consult_error' });
    await process(job());
    const dump = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    expect(dump).toContain(TENANT);
    expect(dump).toContain('ekuatia_consult_error');
    expect(dump).not.toContain(CDC);
  });

  it('rethrows an unexpected error and logs only its class', async () => {
    const { process, logger } = setup(new Error(`db down for ${CDC}`));
    await expect(process(job())).rejects.toThrow('db down');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(CDC);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('Error');
  });

  it('rejects an invalid tenant id before anything else', async () => {
    const { process, execute } = setup({ kind: 'skipped', reason: 'disabled' });
    await expect(process(job({ tenantId: "x'; drop table tenants;--" }))).rejects.toBeInstanceOf(
      InvalidTenantIdError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([[{ cdc: '123' }], [{ cdc: `${CDC}0` }], [{ usageDate: '16/11/2026' }]])(
    'completes a malformed job %j as failed:invalid_job without calling the use case',
    async (bad) => {
      const { process, execute } = setup({ kind: 'skipped', reason: 'disabled' });
      expect(await process(job(bad))).toEqual({ outcome: 'failed:invalid_job' });
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
