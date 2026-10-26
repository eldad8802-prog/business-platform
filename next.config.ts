import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright is Node-native; do not bundle it into the serverless output. @sparticuz/chromium is the
  // serverless Chromium build (AL2023) PDFs are rendered with on Vercel (lib/pdf/chromium.ts).
  serverExternalPackages: ["playwright", "playwright-core", "@sparticuz/chromium"],

  // @sparticuz/chromium resolves its compressed browser at runtime (../../bin), which file tracing cannot
  // see — include it for every route that renders a PDF through lib/pdf/chromium.ts: the accountant PDF
  // report, the billing document PDF (view / download), and every route that reaches preparePeriod — the
  // owner's prepare and recipient change render missing issued-document PDFs; the sweep (SYSTEM actor)
  // never renders but reaches the same code, so it carries the browser too.
  // scripts/ci/pdf-route-tracing-guard.mjs fails CI if a route that reaches the launcher is missed.
  outputFileTracingIncludes: {
    "/api/accountant/packages/\\[packageId\\]/download": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/billing/documents/\\[id\\]/pdf": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/accountant/periods/\\[periodKey\\]/prepare": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/accountant/recipient": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/accountant/sweep": ["./node_modules/@sparticuz/chromium/bin/**/*"],
  },

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
      // The /tools catalogue, retired: it repeated the sidebar and Home's three family tiles. The
      // family screens (/tools/money · customers · operations) stay; a direct visit to the root —
      // including an old /tools#group-* link — lands on Home, where those tiles are. Temporary (307),
      // so the decision stays reversible without browsers caching it.
      {
        source: "/tools",
        destination: "/app",
        permanent: false,
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
        ],
      },
    ];
  },
};

export default nextConfig;
