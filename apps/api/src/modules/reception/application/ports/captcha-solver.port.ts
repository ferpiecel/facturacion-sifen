export type CaptchaSolveErrorCode =
  'not_configured' | 'provider_error' | 'timeout' | 'unsolvable' | 'no_token';

/** Messages are fixed strings per code: they never carry provider text or the API key. */
const MESSAGES: Record<CaptchaSolveErrorCode, string> = {
  not_configured: 'Captcha solver is not configured',
  provider_error: 'Captcha provider request failed',
  timeout: 'Captcha was not solved in time',
  unsolvable: 'Captcha provider could not solve the challenge',
  no_token: 'Captcha provider returned no token',
};

export class CaptchaSolveError extends Error {
  readonly code: CaptchaSolveErrorCode;

  constructor(code: CaptchaSolveErrorCode) {
    super(MESSAGES[code]);
    this.name = 'CaptchaSolveError';
    this.code = code;
  }
}

export interface CaptchaSolver {
  /** Solves a reCAPTCHA v2 challenge and returns the `g-recaptcha-response` token. */
  solveRecaptchaV2(input: { sitekey: string; pageUrl: string }): Promise<string>;
}
