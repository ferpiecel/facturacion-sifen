import type { IncomingMessage, ServerResponse } from 'node:http';

/** The slice of Fastify's request this module reads (the app does not depend on `fastify` directly). */
export interface RequestShape {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions: { readonly url?: string };
  readonly raw: IncomingMessage;
}

/** The slice of Fastify's reply this module uses. */
export interface ReplyShape {
  header(name: string, value: string): unknown;
  hijack(): unknown;
  readonly raw: ServerResponse;
}
