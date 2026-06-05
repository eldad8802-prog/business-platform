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
};

export default nextConfig;
