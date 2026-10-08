import http from 'node:http';
import https from 'node:https';

import { installClientAddressPin } from './security/client-address';

/** Node-only part of `register()`; kept apart so the Edge analysis never sees the `node:` imports. */
export function registerNode(): void {
  const trusted = process.env.PORTAL_TRUSTED_UPSTREAM_PROXY === 'true';
  installClientAddressPin(http.Server.prototype, trusted);
  installClientAddressPin(https.Server.prototype, trusted);
}
