import { NextResponse } from "next/server";

import { clearTicketCookie, GOOGLE_TICKET_COOKIE, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { cancelSignupTicket, isTicketSecret, readSignupTicket } from "@/lib/auth/oauth-ticket";
import { checkBrowserCsrf } from "@/lib/auth/refresh-cookie";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The completion form's view of the ticket this browser holds: the provider-verified address and the name
 * Google gave, for prefill — and nothing else. Reading changes nothing. OFF → 404.
 */
export type TicketRouteDeps = { config: typeof readGoogleLoginConfig; read: typeof readSignupTicket };
const defaultDeps: TicketRouteDeps = { config: readGoogleLoginConfig, read: readSignupTicket };

const noStore = { "cache-control": "no-store" };

export async function handleTicketRead(req: Request, deps: TicketRouteDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const view = await deps.read(readCookie(req, GOOGLE_TICKET_COOKIE));
  if (!view) {
    const res = NextResponse.json({ code: "TICKET_EXPIRED" }, { status: 401, headers: noStore });
    clearTicketCookie(res);
    return res;
  }
  return NextResponse.json(
    { email: view.email, name: view.name, expiresAt: view.expiresAt },
    { headers: noStore }
  );
}

/**
 * The form's "cancel": END the ticket on the server (auth_oauth_ticket_cancel), so no copy of its secret can
 * complete a signup, and only then forget it in this browser.
 *
 *   ended here or before                → 200 { status: "cancelled" }, the cookie cleared;
 *   already unusable (expired, superseded, unknown, none held) → 200 { status: "ended" }, the cookie cleared;
 *   the signup was completed first      → 409 ALREADY_COMPLETED, the cookie cleared; the account is untouched;
 *   cross-site                          → 403, nothing done;
 *   the rate limit                      → 429, the cookie KEPT;
 *   the database (or the limiter) fails → 503 CANCEL_FAILED, the cookie KEPT, so the person can try again.
 * Nothing that failed is ever answered as cancelled. The secret is never logged. OFF → 404.
 */
export type CancelRouteDeps = {
  config: typeof readGoogleLoginConfig;
  cancel: typeof cancelSignupTicket;
  rateLimit: typeof consumeRateLimit;
};
const defaultCancelDeps: CancelRouteDeps = { config: readGoogleLoginConfig, cancel: cancelSignupTicket, rateLimit: consumeRateLimit };

function forgotten(body: Record<string, unknown>, status = 200): NextResponse {
  const res = NextResponse.json(body, { status, headers: noStore });
  clearTicketCookie(res);
  return res;
}

export async function handleTicketCancel(req: Request, deps: CancelRouteDeps = defaultCancelDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkBrowserCsrf(req).ok) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: noStore });

  const secret = readCookie(req, GOOGLE_TICKET_COOKIE);
  if (!isTicketSecret(secret)) return forgotten({ status: "ended" });

  try {
    const rl = await deps.rateLimit({ key: `auth:google-cancel:${getClientIp(req)}`, limit: 20, windowMs: 10 * 60_000 });
    if (!rl.allowed) {
      return NextResponse.json(
        { code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות." },
        { status: 429, headers: noStore }
      );
    }
    const outcome = await deps.cancel(secret);
    if (outcome === "COMPLETED") {
      return forgotten({ code: "ALREADY_COMPLETED", error: "ההרשמה כבר הושלמה והחשבון נפתח. אפשר להתחבר אליו." }, 409);
    }
    return forgotten({ status: outcome === "CANCELLED" || outcome === "ALREADY_CANCELLED" ? "cancelled" : "ended" });
  } catch (error) {
    console.error("[oauth-ticket] cancel_failed", safeErrorSummary(error));
    return NextResponse.json(
      { code: "CANCEL_FAILED", error: "הביטול לא הושלם. ההרשמה עדיין פתוחה, ואפשר לנסות לבטל שוב." },
      { status: 503, headers: noStore }
    );
  }
}

export async function GET(req: Request) {
  return handleTicketRead(req);
}

export async function DELETE(req: Request) {
  return handleTicketCancel(req);
}
