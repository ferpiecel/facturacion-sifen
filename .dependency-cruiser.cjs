'use strict';

// Matches @nestjs/*, @fastify/*, and framework packages used across layers,
// both as resolved pnpm paths and as unresolved bare names (test fixtures).
const FW =
  '(^|node_modules/)((@nestjs|@fastify)/|(fastify|drizzle-orm|bullmq|ioredis|pg|reflect-metadata)(/|$))';

// Third-party SDKs and PDF/QR/image/wasm libraries (excludes libxml2-wasm, used by packages/sifen-xsd).
const SDK_LIBS =
  '(^|node_modules/)((@aws-sdk|@smithy)/|(@anthropic-ai/sdk|pdfjs-dist|jsqr|zxing-wasm|sharp|pngjs|jpeg-js|mupdf)(/|$))';

module.exports = {
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
  },
  forbidden: [
    {
      name: 'domain-app-framework-free',
      severity: 'error',
      comment: 'domain/ and application/ must stay framework-free (ADR-0003)',
      from: { path: '(^|/)modules/[^/]+/(domain|application)/' },
      to: { path: FW },
    },
    {
      name: 'domain-no-outer-layers',
      severity: 'error',
      comment: 'domain/ must not import application/ or infrastructure/',
      from: { path: '(^|/)modules/[^/]+/domain/' },
      to: { path: '(^|/)modules/[^/]+/(application|infrastructure)/' },
    },
    {
      name: 'application-no-infrastructure',
      severity: 'error',
      comment: 'application/ must not import infrastructure/',
      from: { path: '(^|/)modules/[^/]+/application/' },
      to: { path: '(^|/)modules/[^/]+/infrastructure/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'no circular imports anywhere in the workspace',
      from: {},
      to: { circular: true },
    },
    {
      name: 'tips-libs-confined-to-sifen-tips',
      severity: 'error',
      comment:
        'only packages/sifen-tips may import the facturacionelectronicapy-* (TIPS) libraries (ADR-0015)',
      from: { pathNot: '(^|/)packages/sifen-tips/' },
      to: { path: '(^|node_modules/)facturacionelectronicapy-' },
    },
    {
      name: 'sdk-libs-confined-to-infrastructure',
      severity: 'error',
      comment:
        'AWS/Anthropic SDKs and PDF/QR/image libraries may only be imported from modules/*/infrastructure/ (ADR-0020, ADR-0021)',
      from: { pathNot: '(^|/)modules/[^/]+/infrastructure/' },
      to: { path: SDK_LIBS },
    },
  ],
};
