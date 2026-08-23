/**
 * Absolute origin used to build a coupon's scannable `qrValue`.
 *
 * COUPON-01 ROOT CAUSE.
 * `createCouponFromOffer` used to resolve this from `APP_BASE_URL` /
 * `NEXT_PUBLIC_APP_URL` only, and threw a plain `Error` when neither was set:
 *
 *     if (!baseUrl) throw new Error("Missing APP_BASE_URL ...")
 *
 * A plain Error is not an `AppError`, so `handleError` mapped it to a bare 500.
 * Neither variable is set in `.env`, `.env.local` or `.env.production`, so
 * outside `NODE_ENV=development` *every* publish failed with 500 — deterministic,
 * which is exactly the audit's 3/3 reproduction. The `POST /api/offers` call had
 * already committed by then, which is where the orphaned offers came from.
 *
 * WHAT THE FALLBACK IS AND IS NOT.
 * Measured against a running server: `nextUrl.origin` follows
 * `x-forwarded-proto` but ignores both `Host` and `X-Forwarded-Host` — a request
 * sent with `Host: promaxgroup.co.il` still yielded `http://localhost:3000`.
 * So the request origin is a DEVELOPMENT convenience and a guard against the
 * old 500; it is not a way to discover the public domain on a hosted
 * deployment. `APP_BASE_URL` is what makes production correct, and
 * `resolveCouponBaseUrl` refuses to mint a coupon rather than bake a
 * non-public origin into a permanent QR.
 *
 * (Ignoring `X-Forwarded-Host` is also why a spoofed host header cannot poison
 * a coupon's redeem link — verified.)
 */

import { AppError } from "@/lib/errors";

/** Minimal shape needed — keeps this unit-testable without a real NextRequest. */
export type OriginBearingRequest = { nextUrl: { origin: string } };

/**
 * Origins that are certainly wrong for a customer-facing QR. A coupon's
 * `qrValue` is written once and is then permanent — printed, shared, scanned
 * weeks later — so a local/internal origin baked into one is a coupon that can
 * never be redeemed by anybody.
 */
const NON_PUBLIC_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local)(:\d+)?$/i;

export function isPubliclyReachable(origin: string): boolean {
  try {
    return !NON_PUBLIC_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

/**
 * Thrown instead of minting a permanently-broken coupon. This is deliberately
 * NOT the old failure mode: the old code threw a bare `Error` (opaque 500) even
 * when a perfectly good origin was available. This throws only when the result
 * would certainly be wrong, and says exactly how to fix it.
 */
export class CouponBaseUrlError extends AppError {
  constructor(resolved: string) {
    super(
      `Refusing to mint a coupon QR pointing at "${resolved}". Set APP_BASE_URL to the public site origin (e.g. https://promaxgroup.co.il) for this deployment.`,
      503,
      "COUPON_BASE_URL_NOT_PUBLIC"
    );
    this.name = "CouponBaseUrlError";
  }
}

export function resolveCouponBaseUrl(req: OriginBearingRequest): string {
  const configured =
    process.env.APP_BASE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  const base = (configured || req.nextUrl.origin).replace(/\/+$/, "");

  // Outside development, a non-public origin means the deployment is
  // misconfigured. Verified empirically: `nextUrl.origin` does NOT follow the
  // Host or X-Forwarded-Host header, so the request-origin fallback cannot be
  // trusted to produce the public domain on a hosted deployment — it is a
  // development convenience and an anti-500 net, not a production strategy.
  if (process.env.NODE_ENV === "production" && !isPubliclyReachable(base)) {
    throw new CouponBaseUrlError(base);
  }

  return base;
}

/** The URL a scanned coupon QR resolves to. Pure. */
export function buildCouponQrValue(baseUrl: string, token: string): string {
  const url = new URL("/revenue/redeem", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}
