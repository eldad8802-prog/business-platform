import { NextResponse } from "next/server";

import { clearLinkCookie, GOOGLE_LINK_COOKIE, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { cancelLinkTicket, isTicketSecret, readLinkTicket } from "@/lib/auth/oauth-ticket";
import { checkBrowserCsrf } from "@/lib/auth/refresh-cookie";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google", milestone 3 — the link screen's view of the LINK ticket this browser holds: the
 * provider-verified address (which is also the existing account's) and the name Google gave. Nothing else —
 * no account id, no business, nothing the client could send back as authority. Reading changes nothing.
 *
 * DELETE is the screen's "cancel": it ENDS the ticket on the server (auth_oauth_ticket_cancel, purpose LINK)
 * and only then forgets it here, exactly like the signup cancel; a failure keeps the cookie and is never
 * answered as cancelled. OFF → 404.
 */
export type LinkTicketRouteDeps = { config: typeof readGoogleLoginConfig; read: typeof readLinkTicket };
const defaultDeps: LinkTicketRouteDeps = { config: readGoogleLoginConfig, read: readLinkTicket };

const noStore = { "cache-control": "no-store" };

export async function handleLinkTicketRead(req: Request, deps: LinkTicketRouteDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const view = await deps.read(readCookie(req, GOOGLE_LINK_COOKIE));
  if (!view) {
    const res = NextResponse.json({ code: "TICKET_EXPIRED" }, { status: 401, headers: noStore });
    clearLinkCookie(res);
    return res;
  }
  return NextResponse.json({ email: view.email, name: view.name, expiresAt: view.expiresAt }, { headers: noStore });
}

export type LinkCancelDeps = { config: typeof readGoogleLoginConfig; cancel: typeof cancelLinkTicket; rateLimit: typeof consumeRateLimit };
const defaultCancelDeps: LinkCancelDeps = { config: readGoogleLoginConfig, cancel: cancelLinkTicket, rateLimit: consumeRateLimit };

function forgotten(body: Record<string, unknown>, status = 200): NextResponse {
  const res = NextResponse.json(body, { status, headers: noStore });
  clearLinkCookie(res);
  return res;
}

export async function handleLinkCancel(req: Request, deps: LinkCancelDeps = defaultCancelDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkBrowserCsrf(req).ok) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: noStore });

  const secret = readCookie(req, GOOGLE_LINK_COOKIE);
  if (!isTicketSecret(secret)) return forgotten({ status: "ended" });

  try {
    const rl = await deps.rateLimit({ key: `auth:google-cancel:${getClientIp(req)}`, limit: 20, windowMs: 10 * 60_000 });
    if (!rl.allowed) {
      return NextResponse.json({ code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות." }, { status: 429, headers: noStore });
    }
    const outcome = await deps.cancel(secret);
    if (outcome === "COMPLETED") {
      return forgotten({ code: "ALREADY_LINKED", error: "החשבון כבר חובר ל־Google. אפשר להתחבר אליו." }, 409);
    }
    return forgotten({ status: outcome === "CANCELLED" || outcome === "ALREADY_CANCELLED" ? "cancelled" : "ended" });
  } catch (error) {
    console.error("[oauth-ticket] link_cancel_failed", safeErrorSummary(error));
    return NextResponse.json(
      { code: "CANCEL_FAILED", error: "הביטול לא הושלם. אפשר לנסות לבטל שוב." },
      { status: 503, headers: noStore }
    );
  }
}

export async function GET(req: Request) {
  return handleLinkTicketRead(req);
}

export async function DELETE(req: Request) {
  return handleLinkCancel(req);
}
