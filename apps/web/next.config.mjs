const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';
// Extra origins the browser may talk to directly (CSP). Local dev defaults to the API on :4000; in containers nginx serves web and API
// from one origin, so the Docker build passes CSP_API_ORIGINS="" and the policy is 'self' only.
const API_ORIGINS = (process.env.CSP_API_ORIGINS ?? 'http://localhost:4000').trim();
const WS_ORIGINS = process.env.CSP_API_ORIGINS === undefined ? ' ws://localhost:3000' : '';
const extra = API_ORIGINS ? ' ' + API_ORIGINS : '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // In production nginx routes /v1/* straight to the API. This rewrite keeps `next dev` / single-container setups same-origin.
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${API}/v1/:path*` }];
  },
  async headers() {
    const security = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' }, // private events are never indexed (D14)
      { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(), microphone=()' },
      // no third-party origins: fonts, scripts and media are all first-party (data residency)
      {
        key: 'Content-Security-Policy',
        value: ["default-src 'self'", `img-src 'self' data: blob:${extra}`, "media-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", `connect-src 'self'${extra}${WS_ORIGINS}`, "font-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join('; '),
      },
    ];
    return [{ source: '/:path*', headers: security }];
  },
};
export default nextConfig;
