/** Why a delivery attempt produced no HTTP response. Never carries response data or secrets. */
export type WebhookErrorCode =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns_failure'
  | 'connect_failed'
  | 'tls_failure'
  | 'timeout'
  | 'network_error'
  /** Not a transport failure: the signing secret could not be opened, so nothing was sent. */
  | 'secret_unavailable';

/** What one POST amounted to: the status it got back, or the classified reason it did not. */
export type WebhookHttpResult =
  | { readonly kind: 'response'; readonly status: number }
  | { readonly kind: 'error'; readonly code: WebhookErrorCode };

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Outbound webhook transport. Never throws and never follows redirects: a 3xx is just a status. */
export interface WebhookHttpPort {
  post(request: WebhookRequest): Promise<WebhookHttpResult>;
}
