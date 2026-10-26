import bcrypt from "bcrypt";
import { NextResponse } from "next/server";

import { LOGIN_FAILURE_POLICY, loginAccountRateKey } from "@/lib/auth/account-rate-key";
import { loginLockedMessage } from "@/lib/auth/auth-messages";
import { completeGoogleLink, findLinkAccount, GoogleLinkRefusedError } from "@/lib/auth/google-link";
import { deliverGoogleLinkEmailAfterResponse } from "@/lib/auth/google-link-delivery";
import { clearLinkCookie, GOOGLE_LINK_COOKIE, GOOGLE_NOT_IN_PILOT, googleLoginAllows, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { readLoginDevice } from "@/lib/auth/login-device";
import { readLinkTicket } from "@/lib/auth/oauth-ticket";
import { checkBrowserCsrf, setRefreshCookie } from "@/lib/auth/refresh-cookie";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import { getServerI18n } from "@/lib/i18n/server";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp, reserveAttempt } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google", milestone 3 — proof of ownership by the existing account's PASSWORD.
 *
 * The account is never named by the client: it is the one holding the LINK ticket's provider-verified
 * address. The password is compared under EXACTLY the limits login uses — the same per-address ledger
 * (loginAccountRateKey, LOGIN_FAILURE_POLICY: 4 failures in 15 minutes lock it for 15), reserved before any
 * comparison, and the same per-IP limit — so failures here and on the login screen count together,
 * and this path is no way around a lock. An unknown or password-less account costs the same bcrypt work and
 * is answered like a wrong password. Only then does completeGoogleLink spend the ticket, link and sign in —
 * one transaction. The response sets the refresh cookie (no token in the body) and forgets the ticket.
 * During the pilot an unlisted ticket address is refused before the ledger and the password (nothing counted).
 * OFF → 404.
 */
export type LinkPasswordDeps = {
  config: typeof readGoogleLoginConfig;
  readTicket: typeof readLinkTicket;
  findAccount: typeof findLinkAccount;
  rateLimit: typeof consumeRateLimit;
  reserve: typeof reserveAttempt;
  compare: (plain: string, hash: string) => Promise<boolean>;
  complete: typeof completeGoogleLink;
  deliver: typeof deliverGoogleLinkEmailAfterResponse;
};
const defaultDeps: LinkPasswordDeps = {
  config: readGoogleLoginConfig,
  readTicket: readLinkTicket,
  findAccount: findLinkAccount,
  rateLimit: consumeRateLimit,
  reserve: reserveAttempt,
  compare: (plain, hash) => bcrypt.compare(plain, hash),
  complete: completeGoogleLink,
  deliver: deliverGoogleLinkEmailAfterResponse,
};

/** The login route's equaliser: a bcrypt hash (cost 10) of a fixed string that is nobody's password. */
const TIMING_EQUALISER_HASH = "$2b$10$zN1gFgiX48MtiTQ9xbwAjOBLnk7QFfVFoISIbd2r/jR2k.4gSTfmq";
const MAX_PASSWORD_LENGTH = 128;
const noStore = { "cache-control": "no-store" };

function lockedResponse(retryAfterMs: number, message: string): NextResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    { code: "LOGIN_LOCKED", error: message, retryAfterSeconds },
    { status: 429, headers: { ...noStore, "Retry-After": String(retryAfterSeconds) } }
  );
}

function ticketGone(): NextResponse {
  const res = NextResponse.json(
    { code: "TICKET_EXPIRED", error: "תוקף החיבור ל־Google פג. אפשר להתחיל שוב עם Google." },
    { status: 409, headers: noStore }
  );
  clearLinkCookie(res);
  return res;
}

function notInPilot(): NextResponse {
  const res = NextResponse.json(GOOGLE_NOT_IN_PILOT, { status: 403, headers: noStore });
  clearLinkCookie(res);
  return res;
}

export async function handleLinkPassword(req: Request, deps: LinkPasswordDeps = defaultDeps): Promise<NextResponse> {
  const config = deps.config();
  if (!config) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!checkBrowserCsrf(req).ok) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: noStore });
  const { t } = await getServerI18n();

  try {
    // The login route's own per-address limit: this endpoint is password sign-in by another door.
    const rl = await deps.rateLimit({ key: `auth:login:${getClientIp(req)}`, limit: 10, windowMs: 60_000 });
    if (!rl.allowed) {
      return NextResponse.json({ code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד דקה." }, { status: 429, headers: noStore });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ code: "INVALID_BODY", error: "יש להזין סיסמה." }, { status: 400, headers: noStore });
    }
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) {
      return NextResponse.json({ code: "INVALID_BODY", error: "יש להזין סיסמה." }, { status: 400, headers: noStore });
    }

    const secret = readCookie(req, GOOGLE_LINK_COOKIE);
    const ticket = await deps.readTicket(secret);
    if (!ticket) return ticketGone();
    if (!googleLoginAllows(config, ticket.email)) return notInPilot();

    const normalized = normalizeEmail(ticket.email);
    const attempt = await deps.reserve({
      key: loginAccountRateKey(normalized, readLoginDevice(req, normalized)),
      limit: LOGIN_FAILURE_POLICY.limit,
      windowMs: LOGIN_FAILURE_POLICY.windowMs,
    });
    if (!attempt.allowed) return lockedResponse(attempt.retryAfterMs, loginLockedMessage(attempt.retryAfterMs, t));

    const account = await deps.findAccount(ticket.email);
    const valid = (await deps.compare(password, account?.password ?? TIMING_EQUALISER_HASH)) && !!account?.password;
    if (!valid || !account) {
      if (attempt.count >= LOGIN_FAILURE_POLICY.limit) {
        await attempt.lock(LOGIN_FAILURE_POLICY.lockMs);
        return lockedResponse(LOGIN_FAILURE_POLICY.lockMs, loginLockedMessage(LOGIN_FAILURE_POLICY.lockMs, t));
      }
      const warn = attempt.count === LOGIN_FAILURE_POLICY.warnAtFailure;
      return NextResponse.json(
        {
          code: "INVALID_PASSWORD",
          error: "הסיסמה שגויה.",
          ...(warn ? { warning: "נשאר ניסיון אחד לפני נעילה זמנית.", attemptsLeft: 1 } : {}),
        },
        { status: 401, headers: noStore }
      );
    }
    // The right password: the failures before it are cleared — before anything else can fail.
    await attempt.clear();

    const now = new Date();
    const linked = await deps.complete({ ticketSecret: secret, proof: { kind: "PASSWORD", userId: account.id }, now, userAgent: req.headers.get("user-agent") });
    const res = NextResponse.json({ success: true, next: "/app" }, { headers: noStore });
    setRefreshCookie(res, linked.session.credential, { now, absoluteExpiresAt: linked.session.absoluteExpiresAt });
    clearLinkCookie(res);
    deps.deliver(linked.noticeEmailId, linked.businessId);
    return res;
  } catch (error) {
    if (error instanceof GoogleLinkRefusedError) {
      if (error.reason === "TICKET") return ticketGone();
      const res = NextResponse.json({ code: "LINK_REFUSED", error: "לא ניתן לחבר את Google לחשבון הזה." }, { status: 409, headers: noStore });
      clearLinkCookie(res);
      return res;
    }
    console.error("GOOGLE_LINK_PASSWORD_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ code: "SERVER_ERROR", error: "החיבור לא הושלם. אפשר לנסות שוב." }, { status: 500, headers: noStore });
  }
}

export async function POST(req: Request) {
  return handleLinkPassword(req);
}
