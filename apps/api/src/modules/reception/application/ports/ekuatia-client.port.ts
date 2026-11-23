export type EkuatiaConsultErrorCode =
  'not_found' | 'consult_error' | 'timeout' | 'invalid_response';

/**
 * Messages are fixed strings per code: they never carry site text, the reCAPTCHA token or the
 * CDC. A rejected captcha is not modelled: the captures do not show how the site reports it, so
 * it surfaces as `consult_error`.
 */
const MESSAGES: Record<EkuatiaConsultErrorCode, string> = {
  not_found: 'eKuatia has no document for the requested CDC',
  consult_error: 'eKuatia consultation failed',
  timeout: 'eKuatia consultation timed out',
  invalid_response: 'eKuatia returned an unexpected response',
};

export class EkuatiaConsultError extends Error {
  readonly code: EkuatiaConsultErrorCode;

  constructor(code: EkuatiaConsultErrorCode) {
    super(MESSAGES[code]);
    this.name = 'EkuatiaConsultError';
    this.code = code;
  }
}

export interface EkuatiaClient {
  /** Consults the public eKuatia site by CDC with a solved reCAPTCHA token and returns the XML. */
  consultByCdc(input: { cdc: string; recaptchaToken: string }): Promise<{ xml: string }>;
}
