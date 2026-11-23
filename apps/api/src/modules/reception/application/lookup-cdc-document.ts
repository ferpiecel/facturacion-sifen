import type { ReceivedDocument } from '../domain/received-document.js';
import type { EkuatiaCircuitBreaker } from './ekuatia-circuit-breaker.js';
import type { IngestSifenXmlInput, IngestSifenXmlResult } from './ingest-sifen-xml.js';
import { CaptchaSolveError, type CaptchaSolver } from './ports/captcha-solver.port.js';
import { EkuatiaConsultError, type EkuatiaClient } from './ports/ekuatia-client.port.js';
import type { ReceivedDocumentRepository } from './ports/received-document-repository.port.js';

export interface LookupCdcDocumentDeps {
  /** Kill switch (`RECEPTION_EKUATIA_ENABLED`), read again by the worker: a drained job does no solve. */
  readonly enabled: boolean;
  readonly repository: Pick<ReceivedDocumentRepository, 'findByCdc'>;
  readonly quota: { releaseByDay(tenantId: string, usageDate: string): Promise<void> };
  readonly breaker: EkuatiaCircuitBreaker;
  readonly solver: CaptchaSolver;
  readonly client: EkuatiaClient;
  /** The XML path (`IngestSifenXml`): the result is processed exactly like an XML upload. */
  readonly ingestXml: { execute(input: IngestSifenXmlInput): Promise<IngestSifenXmlResult> };
  /** Public reCAPTCHA site key and page of the consultation (UNVERIFIED, configurable). */
  readonly sitekey: string;
  readonly pageUrl: string;
}

export interface LookupCdcDocumentInput {
  readonly tenantId: string;
  readonly cdc: string;
  /** UTC day of the solve slot reserved by the request; given back when nothing is solved. */
  readonly usageDate: string;
  readonly signal?: AbortSignal;
}

/**
 * Stable outcome codes of a lookup. They never carry provider or site text, the CDC or a token.
 */
export type LookupFailureCode =
  | 'captcha_not_configured'
  | 'captcha_balance_exhausted'
  | 'captcha_ip_not_allowed'
  | 'captcha_no_capacity'
  | 'captcha_unsolvable'
  | 'captcha_timeout'
  | 'captcha_no_token'
  | 'captcha_provider_error'
  | 'ekuatia_not_found'
  | 'ekuatia_consult_error'
  | 'ekuatia_timeout'
  | 'ekuatia_invalid_response'
  | 'xml_unreadable'
  | 'aborted';

export type LookupSkipReason = 'already_exists' | 'disabled' | 'circuit_open';

export type LookupCdcDocumentResult =
  /** The XML went through the XML ingest; `document` is `confirmed` or `needs_review`. */
  | { readonly kind: 'ingested'; readonly document: ReceivedDocument; readonly created: boolean }
  | { readonly kind: 'skipped'; readonly reason: LookupSkipReason }
  | {
      readonly kind: 'failed';
      readonly code: LookupFailureCode;
      /** Present when the XML was stored but unreadable (`extraction_failed`). */
      readonly document?: ReceivedDocument;
    };

/**
 * Worker half of the lookup by CDC (reception R6.3): dedupe again (a document may have appeared
 * since the request), consult the circuit breaker, solve the captcha, fetch the XML and hand it to
 * the XML ingest. The solve slot reserved by the request is given back whenever no paid solve was
 * attempted or the provider refused the job upfront; once a solve ran the slot stays spent.
 */
export class LookupCdcDocument {
  constructor(private readonly deps: LookupCdcDocumentDeps) {}

  async execute(input: LookupCdcDocumentInput): Promise<LookupCdcDocumentResult> {
    const { tenantId, cdc, usageDate, signal } = input;
    const { breaker } = this.deps;
    const giveBack = () => this.deps.quota.releaseByDay(tenantId, usageDate);

    if (!this.deps.enabled) {
      await giveBack();
      return { kind: 'skipped', reason: 'disabled' };
    }
    if ((await this.deps.repository.findByCdc(tenantId, cdc)) !== null) {
      await giveBack();
      return { kind: 'skipped', reason: 'already_exists' };
    }
    if (!breaker.tryAcquire()) {
      await giveBack();
      return { kind: 'skipped', reason: 'circuit_open' };
    }

    let token: string;
    try {
      token = await this.deps.solver.solveRecaptchaV2({
        sitekey: this.deps.sitekey,
        pageUrl: this.deps.pageUrl,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (!(error instanceof CaptchaSolveError)) {
        breaker.releaseProbe();
        throw error;
      }
      const failure = solverFailure(error);
      if (failure.fatal) breaker.recordFatal();
      else if (failure.neutral) breaker.releaseProbe();
      else breaker.recordFailure();
      // Refused or never started: no solve was billed, so the slot is not spent.
      if (failure.refunded) await giveBack();
      return { kind: 'failed', code: failure.code };
    }

    let xml: string;
    try {
      ({ xml } = await this.deps.client.consultByCdc({
        cdc,
        recaptchaToken: token,
        ...(signal === undefined ? {} : { signal }),
      }));
    } catch (error) {
      if (!(error instanceof EkuatiaConsultError)) {
        breaker.releaseProbe();
        throw error;
      }
      const failure = consultFailure(error);
      // An unknown document is still a healthy site: the captcha and the site worked.
      if (failure.healthy) breaker.recordSuccess();
      else if (failure.neutral) breaker.releaseProbe();
      else breaker.recordFailure();
      return { kind: 'failed', code: failure.code };
    }
    breaker.recordSuccess();

    // The site must answer for the CDC that was asked: anything else is never ingested, because the
    // dedupe above is keyed by the requested CDC.
    if (!xml.includes(`Id="${cdc}"`)) return { kind: 'failed', code: 'ekuatia_invalid_response' };

    const result = await this.deps.ingestXml.execute({
      tenantId,
      xml: new TextEncoder().encode(xml),
      source: 'ekuatia_cdc',
    });
    if (result.document.status === 'extraction_failed') {
      return { kind: 'failed', code: 'xml_unreadable', document: result.document };
    }
    return { kind: 'ingested', document: result.document, created: result.created };
  }
}

interface SolverFailure {
  readonly code: LookupFailureCode;
  /** Retrying cannot work until a human acts: open the breaker at once. */
  readonly fatal: boolean;
  /** Says nothing about the health of the services (caller abort). */
  readonly neutral: boolean;
  readonly refunded: boolean;
}

function solverFailure(error: CaptchaSolveError): SolverFailure {
  switch (error.code) {
    case 'not_configured':
      return { code: 'captcha_not_configured', fatal: true, neutral: false, refunded: true };
    case 'insufficient_balance':
      return { code: 'captcha_balance_exhausted', fatal: true, neutral: false, refunded: true };
    case 'ip_not_allowed':
      return { code: 'captcha_ip_not_allowed', fatal: true, neutral: false, refunded: true };
    case 'no_capacity':
      return { code: 'captcha_no_capacity', fatal: false, neutral: false, refunded: true };
    case 'aborted':
      return { code: 'aborted', fatal: false, neutral: true, refunded: true };
    case 'unsolvable':
      return { code: 'captcha_unsolvable', fatal: false, neutral: false, refunded: false };
    case 'timeout':
      return { code: 'captcha_timeout', fatal: false, neutral: false, refunded: false };
    case 'no_token':
      return { code: 'captcha_no_token', fatal: false, neutral: false, refunded: false };
    case 'provider_error':
      return { code: 'captcha_provider_error', fatal: false, neutral: false, refunded: false };
  }
}

function consultFailure(error: EkuatiaConsultError): {
  readonly code: LookupFailureCode;
  readonly healthy: boolean;
  readonly neutral: boolean;
} {
  switch (error.code) {
    case 'not_found':
      return { code: 'ekuatia_not_found', healthy: true, neutral: false };
    case 'timeout':
      return { code: 'ekuatia_timeout', healthy: false, neutral: false };
    case 'invalid_response':
      return { code: 'ekuatia_invalid_response', healthy: false, neutral: false };
    case 'aborted':
      return { code: 'aborted', healthy: false, neutral: true };
    case 'consult_error':
      return { code: 'ekuatia_consult_error', healthy: false, neutral: false };
  }
}
