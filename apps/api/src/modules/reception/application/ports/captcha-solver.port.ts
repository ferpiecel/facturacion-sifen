export type CaptchaSolveErrorCode =
  | 'not_configured'
  | 'provider_error'
  | 'timeout'
  | 'unsolvable'
  | 'no_token'
  /** The provider account has no balance left: retrying cannot help until it is topped up. */
  | 'insufficient_balance'
  /** The provider has no free worker at the moment (transient, provider side). */
  | 'no_capacity'
  /** The provider rejects this server's IP (account allow-list). */
  | 'ip_not_allowed'
  /** The caller's `AbortSignal` fired. */
  | 'aborted';

/** Messages are fixed strings per code: they never carry provider text or the API key. */
const MESSAGES: Record<CaptchaSolveErrorCode, string> = {
  not_configured: 'Captcha solver is not configured',
  provider_error: 'Captcha provider request failed',
  timeout: 'Captcha was not solved in time',
  unsolvable: 'Captcha provider could not solve the challenge',
  no_token: 'Captcha provider returned no token',
  insufficient_balance: 'Captcha provider account has no balance',
  no_capacity: 'Captcha provider has no capacity available',
  ip_not_allowed: 'Captcha provider does not allow this server address',
  aborted: 'Captcha solve was aborted',
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
  solveRecaptchaV2(input: {
    sitekey: string;
    pageUrl: string;
    /** Aborting stops the solve with `aborted`; nothing is polled afterwards. */
    signal?: AbortSignal;
  }): Promise<string>;
}
