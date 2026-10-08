import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright is Node-native; do not bundle it into the serverless output.
  serverExternalPackages: ["playwright", "playwright-core"],

  // QA evidence (screenshots, logs, proof tables) is repository documentation,
  // never runtime input. Routes with dynamic filesystem access — e.g. the
  // billing PDF route (process.cwd()-relative font + storage paths) — make the
  // file tracer include the whole project, which put qa-evidence/** (~100 MB)
  // into serverless functions and brought api/billing/documents/[id]/pdf to the
  // 250 MB limit. Excluded from every route's trace ('/*' matches all routes;
  // picomatch `contains`). Runtime assets the PDF needs (public/fonts, the font
  // VFS, playwright) are unaffected.
  outputFileTracingExcludes: {
    "/*": ["qa-evidence/**"],
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
