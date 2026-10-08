/** Pinned Redoc standalone bundle; the SRI hash makes the browser reject a tampered CDN response. */
const REDOC_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/redoc@2.5.0/bundles/redoc.standalone.js';
const REDOC_SCRIPT_SRI = 'sha384-4vOjrBu7SuDWXcAw1qFznVLA/sKL+0l4nn+J1HY8w7cpa6twQEYuh4b0Cwuo7CyX';

export const SPEC_PATH = '/docs/openapi.json';

/**
 * Locked down to what Redoc needs: no inline script (the `<redoc>` element reads the spec from
 * `SPEC_PATH`), the one pinned CDN host for the script, inline styles and blob workers for its renderer.
 */
export const REDOC_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  'script-src https://cdn.jsdelivr.net',
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  "img-src 'self' data: https:",
  "connect-src 'self'",
  'worker-src blob:',
  'child-src blob:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const REDOC_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Facturacion SIFEN API</title>
  </head>
  <body>
    <redoc spec-url="${SPEC_PATH}"></redoc>
    <script src="${REDOC_SCRIPT_URL}" integrity="${REDOC_SCRIPT_SRI}" crossorigin="anonymous"></script>
  </body>
</html>
`;
