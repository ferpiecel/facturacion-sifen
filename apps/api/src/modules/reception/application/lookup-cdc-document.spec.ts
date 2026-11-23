import { describe, expect, it, vi } from 'vitest';
import { createReceivedDocument } from '../domain/received-document.js';
import { EkuatiaCircuitBreaker } from './ekuatia-circuit-breaker.js';
import { EkuatiaSolveQuota } from './ekuatia-solve-quota.js';
import { LookupCdcDocument } from './lookup-cdc-document.js';
import { CaptchaSolveError, type CaptchaSolveErrorCode } from './ports/captcha-solver.port.js';
import { EkuatiaConsultError, type EkuatiaConsultErrorCode } from './ports/ekuatia-client.port.js';
import type { IngestSifenXmlInput, IngestSifenXmlResult } from './ingest-sifen-xml.js';
import {
  InMemoryReceptionRepository,
  InMemorySolveUsageStore,
} from './testing/in-memory-reception.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CDC = '01444444017001001001452822017012515873260988';
const DAY = '2026-11-16';
const XML = '<rDE>fixture</rDE>';
const AT = new Date('2026-11-16T10:00:00.000Z');

function harness(
  over: {
    enabled?: boolean;
    solve?: () => Promise<string>;
    consult?: () => Promise<{ xml: string }>;
    ingest?: (input: IngestSifenXmlInput) => Promise<IngestSifenXmlResult>;
    threshold?: number;
  } = {},
) {
  const repository = new InMemoryReceptionRepository();
  const store = new InMemorySolveUsageStore();
  const quota = new EkuatiaSolveQuota({
    store,
    tenantCap: 5,
    globalCap: 50,
    now: () => AT,
    log: () => undefined,
  });
  const clock = { at: AT.getTime() };
  const breaker = new EkuatiaCircuitBreaker({
    failureThreshold: over.threshold ?? 2,
    cooldownMs: 60_000,
    now: () => new Date(clock.at),
  });
  const document = createReceivedDocument({
    id: '00000000-0000-4000-8000-0000000000aa',
    tenantId: TENANT,
    source: 'ekuatia_cdc',
    isOwnReceiver: true,
  });
  const solveSpy = vi.fn(over.solve ?? (() => Promise.resolve('TOKEN')));
  const consultSpy = vi.fn(over.consult ?? (() => Promise.resolve({ xml: XML })));
  const ingestSpy = vi.fn(
    over.ingest ??
      (() =>
        Promise.resolve({ created: true, document, events: [] as const } as IngestSifenXmlResult)),
  );
  const useCase = new LookupCdcDocument({
    enabled: over.enabled ?? true,
    repository,
    quota,
    breaker,
    solver: { solveRecaptchaV2: solveSpy },
    client: { consultByCdc: consultSpy },
    ingestXml: { execute: ingestSpy },
    sitekey: 'sitekey',
    pageUrl: 'https://ekuatia.invalid/consultas/',
  });
  return {
    useCase,
    repository,
    store,
    breaker,
    clock,
    solveSpy,
    consultSpy,
    ingestSpy,
    document,
    quota,
  };
}

async function reserved(h: ReturnType<typeof harness>) {
  const slot = await h.quota.reserve(TENANT);
  expect(slot.ok).toBe(true);
}
const job = { tenantId: TENANT, cdc: CDC, usageDate: DAY };

/** Spec: reception R6.3 (worker side). */
describe('LookupCdcDocument', () => {
  it('solves, consults and ingests the XML as source ekuatia_cdc', async () => {
    const h = harness();
    await reserved(h);
    const result = await h.useCase.execute(job);
    expect(result).toEqual({ kind: 'ingested', document: h.document, created: true });
    expect(h.solveSpy).toHaveBeenCalledWith({
      sitekey: 'sitekey',
      pageUrl: 'https://ekuatia.invalid/consultas/',
    });
    expect(h.consultSpy).toHaveBeenCalledWith({ cdc: CDC, recaptchaToken: 'TOKEN' });
    const ingestInput = h.ingestSpy.mock.calls[0]?.[0];
    expect(ingestInput.tenantId).toBe(TENANT);
    expect(ingestInput.source).toBe('ekuatia_cdc');
    expect(new TextDecoder().decode(ingestInput.xml)).toBe(XML);
    expect(h.store.tenantUsed(TENANT, DAY)).toBe(1); // the slot stays spent
  });

  it('dedupes before solving when the document appeared meanwhile, and gives the slot back', async () => {
    const h = harness();
    await reserved(h);
    await h.repository.create(TENANT, { document: h.document, header: { cdc: CDC } });
    const result = await h.useCase.execute(job);
    expect(result).toEqual({ kind: 'skipped', reason: 'already_exists' });
    expect(h.solveSpy).not.toHaveBeenCalled();
    expect(h.store.tenantUsed(TENANT, DAY)).toBe(0);
  });

  it('does nothing and gives the slot back when the kill switch was turned off', async () => {
    const h = harness({ enabled: false });
    await reserved(h);
    expect(await h.useCase.execute(job)).toEqual({ kind: 'skipped', reason: 'disabled' });
    expect(h.solveSpy).not.toHaveBeenCalled();
    expect(h.store.tenantUsed(TENANT, DAY)).toBe(0);
  });

  it('does not solve while the breaker is open, and gives the slot back', async () => {
    const h = harness();
    h.breaker.recordFatal();
    await reserved(h);
    expect(await h.useCase.execute(job)).toEqual({ kind: 'skipped', reason: 'circuit_open' });
    expect(h.solveSpy).not.toHaveBeenCalled();
    expect(h.store.tenantUsed(TENANT, DAY)).toBe(0);
  });

  it.each<[CaptchaSolveErrorCode, string, boolean]>([
    ['not_configured', 'captcha_not_configured', true],
    ['insufficient_balance', 'captcha_balance_exhausted', true],
    ['ip_not_allowed', 'captcha_ip_not_allowed', true],
    ['no_capacity', 'captcha_no_capacity', true],
    ['aborted', 'aborted', true],
    ['unsolvable', 'captcha_unsolvable', false],
    ['timeout', 'captcha_timeout', false],
    ['no_token', 'captcha_no_token', false],
    ['provider_error', 'captcha_provider_error', false],
  ])('maps solver error %s to %s (slot released: %s)', async (code, mapped, released) => {
    const h = harness({ solve: () => Promise.reject(new CaptchaSolveError(code)) });
    await reserved(h);
    expect(await h.useCase.execute(job)).toEqual({ kind: 'failed', code: mapped });
    expect(h.store.tenantUsed(TENANT, DAY)).toBe(released ? 0 : 1);
    expect(h.consultSpy).not.toHaveBeenCalled();
  });

  it.each<[EkuatiaConsultErrorCode, string]>([
    ['not_found', 'ekuatia_not_found'],
    ['consult_error', 'ekuatia_consult_error'],
    ['timeout', 'ekuatia_timeout'],
    ['invalid_response', 'ekuatia_invalid_response'],
    ['aborted', 'aborted'],
  ])('maps eKuatia error %s to %s and keeps the spent slot', async (code, mapped) => {
    const h = harness({ consult: () => Promise.reject(new EkuatiaConsultError(code)) });
    await reserved(h);
    expect(await h.useCase.execute(job)).toEqual({ kind: 'failed', code: mapped });
    expect(h.store.tenantUsed(TENANT, DAY)).toBe(1);
    expect(h.ingestSpy).not.toHaveBeenCalled();
  });

  it('opens the breaker at once on zero balance, so the next lookup is not solved', async () => {
    const h = harness({
      solve: () => Promise.reject(new CaptchaSolveError('insufficient_balance')),
      threshold: 10,
    });
    await reserved(h);
    await h.useCase.execute(job);
    expect(h.breaker.state()).toBe('open');
    await reserved(h);
    expect(await h.useCase.execute(job)).toEqual({ kind: 'skipped', reason: 'circuit_open' });
    expect(h.solveSpy).toHaveBeenCalledTimes(1);
  });

  it('opens the breaker after consecutive site failures and closes it again after a good probe', async () => {
    let fail = true;
    const h = harness({
      consult: () =>
        fail
          ? Promise.reject(new EkuatiaConsultError('consult_error'))
          : Promise.resolve({ xml: XML }),
      threshold: 2,
    });
    for (let i = 0; i < 2; i += 1) {
      await reserved(h);
      await h.useCase.execute(job);
    }
    expect(h.breaker.state()).toBe('open');
    h.clock.at += 60_000;
    fail = false;
    await reserved(h);
    expect((await h.useCase.execute(job)).kind).toBe('ingested');
    expect(h.breaker.state()).toBe('closed');
  });

  it('a document unknown to eKuatia counts as a healthy site, not a failure', async () => {
    const h = harness({
      consult: () => Promise.reject(new EkuatiaConsultError('not_found')),
      threshold: 1,
    });
    await reserved(h);
    await h.useCase.execute(job);
    expect(h.breaker.state()).toBe('closed');
  });

  it('an XML the parser rejects is a failed lookup, and the stored extraction_failed document is reported', async () => {
    const failed = { ...harness().document, status: 'extraction_failed' as const };
    const h = harness({
      ingest: () =>
        Promise.resolve({ created: true, document: failed, events: [] } as IngestSifenXmlResult),
    });
    await reserved(h);
    expect(await h.useCase.execute(job)).toEqual({
      kind: 'failed',
      code: 'xml_unreadable',
      document: failed,
    });
  });

  it('passes the caller signal to the solver and the client', async () => {
    const h = harness();
    await reserved(h);
    const controller = new AbortController();
    await h.useCase.execute({ ...job, signal: controller.signal });
    expect(h.solveSpy.mock.calls[0]?.[0]).toMatchObject({ signal: controller.signal });
    expect(h.consultSpy.mock.calls[0]?.[0]).toMatchObject({ signal: controller.signal });
  });

  it('rethrows an error that is not a typed solver or client error, freeing the breaker probe', async () => {
    const h = harness({ solve: () => Promise.reject(new TypeError('bug')), threshold: 1 });
    h.breaker.recordFailure();
    h.clock.at += 60_000;
    await reserved(h);
    await expect(h.useCase.execute(job)).rejects.toBeInstanceOf(TypeError);
    expect(h.breaker.tryAcquire()).toBe(true); // the probe was released, not stuck
  });

  it('never puts the token, the CDC or provider text in a failure', async () => {
    const h = harness({ consult: () => Promise.reject(new EkuatiaConsultError('consult_error')) });
    await reserved(h);
    const dump = JSON.stringify(await h.useCase.execute(job));
    expect(dump).not.toContain('TOKEN');
    expect(dump).not.toContain(CDC);
  });
});
