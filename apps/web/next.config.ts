import type { NextConfig } from 'next';

import { apiRewrites } from './src/security/api-proxy';
import { securityHeaders } from './src/security/security-headers';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  rewrites() {
    return Promise.resolve(apiRewrites(process.env.API_INTERNAL_URL));
  },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: securityHeaders(process.env.NODE_ENV !== 'production'),
      },
    ]);
  },
};

export default nextConfig;
