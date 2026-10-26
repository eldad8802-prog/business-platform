import { NextResponse } from "next/server";

import { requestLinkEmail } from "@/lib/auth/google-link";
import { deliverGoogleLinkEmailAfterResponse } from "@/lib/auth/google-link-delivery";
import { clearLinkCookie, GOOGLE_LINK_COOKIE, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { readLinkTicket } from "@/lib/auth/oauth-ticket";
import { checkBrowserCsrf } from "@/lib/auth/refresh-cookie";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google", milestone 3 — "email me a link": the proof of ownership by the existing account's
 * INBOX. The link goes to the account's address and is bound to the LINK ticket this browser holds; the
 * database decides whether one is issued (open ticket, an account that may be linked, 3 per ticket and 5 per
 * account and hour) and the answer is the same either way — "if it can be sent, it is on its way" — so this
 * endpoint says nothing about any account beyond what the person, who proved this address to Google, already
 * knows. The email is recorded in the same transaction and sent after the response (or by the sweep).
 * Only an expired ticket is answered differently: the screen has nothing left to offer. OFF → 404.
 */
export type LinkEmailDeps = {
  config: typeof readGoogleLoginConfig;
  readTicket: typeof readLinkTicket;
  rateLimit: typeof consumeRateLimit;
  request: typeof requestLinkEmail;
  deliver: typeof deliverGoogleLinkEmailAfterResponse;
};
const defaultDeps: LinkEmailDeps = {
  config: readGoogleLoginConfig,
  readTicket: readLinkTicket,
  rateLimit: consumeRateLimit,
  request: requestLinkEmail,
  deliver: deliverGoogleLinkEmailAfterResponse,
};

const noStore = { "cache-control": "no-store" };

export async function handleLinkEmailRequest(req: Request, deps: LinkEmailDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkBrowserCsrf(req).ok) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: noStore });
  try {
    const rl = await deps.rateLimit({ key: `auth:google-link-email:${getClientIp(req)}`, limit: 5, windowMs: 10 * 60_000 });
    if (!rl.allowed) {
      return NextResponse.json({ code: "RATE_LIMITED", error: "יותר מדי בקשות. אפשר לבקש שוב בעוד כמה דקות." }, { status: 429, headers: noStore });
    }
    const secret = readCookie(req, GOOGLE_LINK_COOKIE);
    if (!(await deps.readTicket(secret))) {
      const res = NextResponse.json({ code: "TICKET_EXPIRED", error: "תוקף החיבור ל־Google פג. אפשר להתחיל שוב עם Google." }, { status: 409, headers: noStore });
      clearLinkCookie(res);
      return res;
    }
    const sent = await deps.request(secret, new Date());
    if (sent) deps.deliver(sent.emailId, sent.businessId);
    return NextResponse.json({ status: "sent" }, { headers: noStore });
  } catch (error) {
    console.error("GOOGLE_LINK_EMAIL_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ code: "SERVER_ERROR", error: "שליחת הקישור לא הצליחה. אפשר לנסות שוב." }, { status: 500, headers: noStore });
  }
}

export async function POST(req: Request) {
  return handleLinkEmailRequest(req);
}
