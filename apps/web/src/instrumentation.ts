/** Runs once when the Next server starts (Node runtime only). See `security/client-address.ts`. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const [{ default: http }, { default: https }, { installClientAddressPin }] = await Promise.all([
    import('node:http'),
    import('node:https'),
    import('./security/client-address'),
  ]);
  const trusted = process.env.PORTAL_TRUSTED_UPSTREAM_PROXY === 'true';
  installClientAddressPin(http.Server.prototype, trusted);
  installClientAddressPin(https.Server.prototype, trusted);
}
