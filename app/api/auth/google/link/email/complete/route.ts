import { NextResponse } from "next/server";

import { completeGoogleLink, GoogleLinkRefusedError } from "@/lib/auth/google-link";
import { deliverGoogleLinkEmailAfterResponse } from "@/lib/auth/google-link-delivery";
import { clearLinkCookie, GOOGLE_LINK_COOKIE, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { checkBrowserCsrf, setRefreshCookie } from "@/lib/auth/refresh-cookie";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google", milestone 3 — the EXPLICIT confirmation of an emailed link (a button, never the
 * link's opening). It needs both halves in this browser: the emailed link (posted from the URL fragment) and
 * the LINK ticket it is bound to (the httpOnly cookie). completeGoogleLink spends the ticket, then the link
 * (which the database accepts only for that very ticket and the account it was sent to), links, and signs
 * in — one transaction. The response sets the refresh cookie (no token in the body) and forgets the ticket.
 * OFF → 404.
 */
export type LinkEmailCompleteDeps = {
  config: typeof readGoogleLoginConfig;
  rateLimit: typeof consumeRateLimit;
  complete: typeof completeGoogleLink;
  deliver: typeof deliverGoogleLinkEmailAfterResponse;
};
const defaultDeps: LinkEmailCompleteDeps = {
  config: readGoogleLoginConfig,
  rateLimit: consumeRateLimit,
  complete: completeGoogleLink,
  deliver: deliverGoogleLinkEmailAfterResponse,
};

const noStore = { "cache-control": "no-store" };

function refused(code: string, error: string, clear: boolean): NextResponse {
  const res = NextResponse.json({ code, error }, { status: 409, headers: noStore });
  if (clear) clearLinkCookie(res);
  return res;
}

export async function handleLinkEmailComplete(req: Request, deps: LinkEmailCompleteDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkBrowserCsrf(req).ok) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: noStore });
  try {
    const rl = await deps.rateLimit({ key: `auth:google-link-complete:${getClientIp(req)}`, limit: 10, windowMs: 10 * 60_000 });
    if (!rl.allowed) return NextResponse.json({ code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות." }, { status: 429, headers: noStore });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return refused("LINK_INVALID", "הקישור אינו תקין.", false);
    }
    const now = new Date();
    const linked = await deps.complete({
      ticketSecret: readCookie(req, GOOGLE_LINK_COOKIE),
      proof: { kind: "EMAIL", token: (body as { token?: unknown } | null)?.token },
      now,
      userAgent: req.headers.get("user-agent"),
    });
    const res = NextResponse.json({ success: true, next: "/app" }, { headers: noStore });
    setRefreshCookie(res, linked.session.credential, { now, absoluteExpiresAt: linked.session.absoluteExpiresAt });
    clearLinkCookie(res);
    deps.deliver(linked.noticeEmailId, linked.businessId);
    return res;
  } catch (error) {
    if (error instanceof GoogleLinkRefusedError) {
      if (error.reason === "TICKET") return refused("TICKET_EXPIRED", "החיבור ל־Google בדפדפן הזה כבר לא פתוח. אפשר להתחיל שוב עם Google.", true);
      if (error.reason === "EMAIL_LINK") return refused("LINK_INVALID", "הקישור כבר שומש, פג תוקפו או שאינו שייך לדפדפן הזה.", false);
      return refused("LINK_REFUSED", "לא ניתן לחבר את Google לחשבון הזה.", true);
    }
    console.error("GOOGLE_LINK_EMAIL_COMPLETE_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ code: "SERVER_ERROR", error: "החיבור לא הושלם. אפשר לנסות שוב." }, { status: 500, headers: noStore });
  }
}

export async function POST(req: Request) {
  return handleLinkEmailComplete(req);
}
