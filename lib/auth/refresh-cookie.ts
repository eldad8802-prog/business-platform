/**
 * PERSISTENT LOGIN — the browser half.
 *
 * Everything here is about one client: cookie attributes, the CSRF checks a
 * browser makes possible, and nothing else. The session engine in
 * `refresh-session.ts` never imports this, so a future native or server-to-
 * server caller can reuse the engine without inheriting assumptions that only
 * hold for a browser.
 */

import type { NextResponse } from "next/server";

export const REFRESH_COOKIE = "dubiz_rt";

/**
 * Scoped to the one endpoint that consumes it, so it is not attached to every
 * request the app makes. This is a blast-radius measure and is deliberately NOT
 * counted as a CSRF defence — `Path` is trivial to satisfy from another origin.
 * SameSite=Strict is the structural defence; the Origin check below is the
 * belt to its braces.
 */
export const REFRESH_PATH = "/api/auth/refresh";

/** 30 days, matching idle. Never longer than what remains of the 90-day ceiling. */
const MAX_AGE_CAP_SECONDS = 30 * 24 * 60 * 60;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function refreshCookieMaxAge(now: Date, absoluteExpiresAt: Date): number {
  const remaining = Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000);
  return Math.max(0, Math.min(MAX_AGE_CAP_SECONDS, remaining));
}

export function setRefreshCookie(
  res: NextResponse,
  credential: string,
  opts: { now: Date; absoluteExpiresAt: Date }
): void {
  res.cookies.set({
    name: REFRESH_COOKIE,
    value: credential,
    httpOnly: true,
    // Off in local dev only, where there is no TLS. Production is always https.
    secure: isProduction(),
    sameSite: "strict",
    path: REFRESH_PATH,
    maxAge: refreshCookieMaxAge(opts.now, opts.absoluteExpiresAt),
  });
}

/**
 * Clearing does not require the cookie to have been sent, which matters because
 * `Path` keeps it away from the logout endpoint: the attributes below are what
 * identify which cookie to expire.
 */
export function clearRefreshCookie(res: NextResponse): void {
  res.cookies.set({
    name: REFRESH_COOKIE,
    value: "",
    httpOnly: true,
    secure: isProduction(),
    sameSite: "strict",
    path: REFRESH_PATH,
    maxAge: 0,
  });
}

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}

export type CsrfVerdict = { ok: true } | { ok: false; reason: "bad_origin" | "cross_site" };

/**
 * SameSite=Strict already stops a cross-site browser from attaching this cookie.
 * These checks are the second, independent layer, for the case where that
 * assumption is wrong — an old browser, a proxy that rewrites, a future relax of
 * the attribute by someone who did not read why it is there.
 *
 * `Origin` is REQUIRED, not merely checked when present: treating a missing
 * header as acceptable is how an Origin check quietly becomes optional.
 * `Sec-Fetch-Site` corroborates when the browser sends it, and is not required,
 * because not every client emits it.
 */
export function checkBrowserCsrf(req: Request): CsrfVerdict {
  const origin = req.headers.get("origin");
  if (!origin) return { ok: false, reason: "bad_origin" };

  // Compared against the HOST the request arrived on, not against `req.url`.
  // Behind a proxy the URL a route handler sees is not reliably the public one,
  // and an origin check that compares against an internal URL is an origin check
  // that never matches — which fails closed loudly here, but only because the
  // header is the thing being compared.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return { ok: false, reason: "bad_origin" };

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { ok: false, reason: "bad_origin" };
  }
  if (originHost !== host) return { ok: false, reason: "bad_origin" };

  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return { ok: false, reason: "cross_site" };
  }
  return { ok: true };
}
