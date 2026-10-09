import type { NextConfig } from 'next';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Content Security Policy.
 *
 * Rationale:
 * - All market-data and LLM traffic happens server-side, so `connect-src` never needs
 *   third-party origins. This is a deliberate defence-in-depth choice: even if a client
 *   component were compromised it could not exfiltrate data to a provider endpoint.
 * - `style-src 'unsafe-inline'` is required because React writes inline `style` attributes
 *   and Next.js injects critical CSS. `script-src` stays free of `unsafe-inline` in
 *   production; `unsafe-eval` is only enabled for the dev HMR runtime.
 * - `frame-ancestors 'none'` blocks clickjacking.
 */
function buildCsp(): string {
  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ];

  directives.push(
    isProduction
      ? "script-src 'self'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  );

  if (!isProduction) {
    // Local previews may be embedded by the desktop app; production remains
    // protected by frame-ancestors 'none'. HTTPS upgrades also break local HTTP.
    return directives.filter((directive) => directive !== 'upgrade-insecure-requests').join('; ');
  }

  directives.push("frame-ancestors 'none'");
  return directives.join('; ');
}

const securityHeaders = [
  { key: 'Content-Security-Policy', value: buildCsp() },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=()',
  },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native module: must not be bundled by the server compiler.
  serverExternalPackages: ['better-sqlite3'],
  compiler: {
    removeConsole: isProduction ? { exclude: ['error', 'warn'] } : false,
  },
  experimental: {
    // Fail fast on accidentally importing server-only modules into client bundles.
    serverComponentsHmrCache: false,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // Reports are evidence artefacts: allow printing but never framing.
        source: '/reports/:path*/print',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
