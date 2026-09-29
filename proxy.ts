/**
 * Proxy (Next 16's successor to middleware) — per-request CSP nonce (M-8).
 *
 * A fresh 128-bit nonce is generated for every document request, put into the
 * Content-Security-Policy on BOTH the request (Next.js reads it from there and
 * stamps every framework script and inline flight payload with it) and the
 * response (the browser enforces it). Following the Next.js CSP guide
 * (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md):
 * nonces require dynamic rendering, which the root layout guarantees by
 * reading the request headers.
 *
 * Not matched: API routes (JSON, no documents), static assets, image
 * optimisation, and prefetches (their payloads are not documents).
 */
import { NextResponse, type NextRequest } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/security/csp";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|woff2?)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
