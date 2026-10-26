import { NextResponse } from "next/server";

import { checkLinkEmail } from "@/lib/auth/google-link";
import { GOOGLE_LINK_COOKIE, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { checkBrowserCsrf } from "@/lib/auth/refresh-cookie";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google", milestone 3 — what the confirmation page shows for the emailed link it was opened
 * with: VALID only in the browser holding the LINK ticket the link is bound to (else OTHER_BROWSER), or why
 * it cannot be used (USED / EXPIRED / SUPERSEDED / TICKET_ENDED / INVALID). It CHANGES NOTHING: opening the
 * email link — by its owner or by a mail scanner — links nothing and spends nothing; only the explicit
 * confirmation (./../complete) does. The token travels in the URL fragment and reaches the server only in
 * this POST body, never in a URL. OFF → 404.
 */
export type LinkEmailCheckDeps = { config: typeof readGoogleLoginConfig; check: typeof checkLinkEmail; rateLimit: typeof consumeRateLimit };
const defaultDeps: LinkEmailCheckDeps = { config: readGoogleLoginConfig, check: checkLinkEmail, rateLimit: consumeRateLimit };

const noStore = { "cache-control": "no-store" };

export async function handleLinkEmailCheck(req: Request, deps: LinkEmailCheckDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkBrowserCsrf(req).ok) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: noStore });
  try {
    const rl = await deps.rateLimit({ key: `auth:google-link-check:${getClientIp(req)}`, limit: 30, windowMs: 10 * 60_000 });
    if (!rl.allowed) return NextResponse.json({ code: "RATE_LIMITED" }, { status: 429, headers: noStore });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ status: "INVALID" }, { headers: noStore });
    }
    const status = await deps.check((body as { token?: unknown } | null)?.token, readCookie(req, GOOGLE_LINK_COOKIE));
    return NextResponse.json({ status }, { headers: noStore });
  } catch (error) {
    console.error("GOOGLE_LINK_CHECK_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ code: "SERVER_ERROR" }, { status: 500, headers: noStore });
  }
}

export async function POST(req: Request) {
  return handleLinkEmailCheck(req);
}
