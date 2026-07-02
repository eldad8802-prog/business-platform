import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright is Node-native; do not bundle it into the serverless output.
  serverExternalPackages: ["playwright", "playwright-core"],

  // Corporate apex (promaxgroup.co.il) serves the public Corporate Home.
  // `beforeFiles` is required: the app's `/` route (app/(shell)/page.tsx)
  // exists, so an `afterFiles`/array rewrite would never fire. This rewrite
  // ONLY matches the apex host — *.vercel.app keeps serving the app at `/`.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/",
          has: [{ type: "host", value: "promaxgroup.co.il" }],
          destination: "/home",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },

  // WP3 SEC-18 / gap (audit §2.6) — application-layer security headers.
  // Conservative Phase-1 posture: HSTS + X-Frame-Options + X-Content-Type-Options +
  // Referrer-Policy are ENFORCED (low breakage risk). CSP is Report-Only (never blocks;
  // gathers violation data). Do NOT switch CSP to enforce until report data proves no breakage.
  async headers() {
    const cspReportOnly = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob: https:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
        ],
      },
    ];
  },
};

export default nextConfig;
