import type { NextConfig } from "next";
import { PERMISSIONS_POLICY } from "./lib/security/csp";

const nextConfig: NextConfig = {
  // I-1: do not advertise the framework (X-Powered-By: Next.js).
  poweredByHeader: false,

  // Playwright is Node-native; do not bundle it into the serverless output.
  serverExternalPackages: ["playwright", "playwright-core"],

  // Retire the legacy duplicate homepage `/corporate-home` (superseded by
  // Homepage v1 at `/home`). It has zero internal consumers but was publicly
  // reachable, so we RETIRE it behind a permanent (308) compatibility redirect
  // to the canonical `/home` rather than hard-deleting to a 404 — preserving any
  // external bookmarks / indexed links. `permanent: true` emits HTTP 308.
  async redirects() {
    return [
      {
        source: "/corporate-home",
        destination: "/home",
        permanent: true,
      },
      // The homepage v4 candidate route, retired by the 2026-09-23 cutover:
      // its content IS `/home` now. Anyone holding a review link lands on the
      // canonical page instead of a 404, and no second public copy survives.
      {
        source: "/home-candidate",
        destination: "/home",
        permanent: true,
      },
    ];
  },

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

  // Static security response headers (T1 / gap H-3). Applied to all routes.
  // Scope is exactly these four headers: no CSP, no Permissions-Policy, no
  // HSTS `preload` (kept reversible), no other header. Behaviour-preserving:
  // X-Frame-Options is SAMEORIGIN (same-origin blob: previews unaffected),
  // and no Permissions-Policy so the camera scanners keep working.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // I-1 / M-8 (sec-B): camera and geolocation for this origin only (the
          // scanners and the coupon locator); every other powerful feature off.
          // The Content-Security-Policy itself is per request (nonce) and is set
          // by proxy.ts, not here.
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
        ],
      },
    ];
  },
};

export default nextConfig;
