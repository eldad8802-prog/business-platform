/**
 * /api/security/google — the signed-in owner's own Google link (Settings → Security).
 *
 *   GET  — linked or not, the Google address at link, when, last used; and whether the account has a password
 *          (it decides whether "disconnect" is offered). Only the caller's own account (the verified token's
 *          user), never one named by the client.
 *   POST — disconnect. The owner re-authenticates with the account's password first, under EXACTLY the
 *          limits login uses (the same per-address ledger and lock), and only an account WITH a password may
 *          disconnect — without one it could no longer sign in. The database enforces that too
 *          (auth_oauth_identity_unlink). The removal and its GOOGLE_UNLINKED notice are one transaction.
 *
 * Follows the "Continue with Google" flag: OFF → 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import bcrypt from "bcrypt";
import { NextResponse } from "next/server";

import { authRequiredResponse, getAuthContext } from "@/lib/auth";
import { LOGIN_FAILURE_POLICY, loginAccountRateKey } from "@/lib/auth/account-rate-key";
import { loginLockedMessage } from "@/lib/auth/auth-messages";
import { readAccountCredentials, readGoogleLinkStatus, unlinkGoogle } from "@/lib/auth/google-link";
import { deliverGoogleLinkEmailAfterResponse } from "@/lib/auth/google-link-delivery";
import { readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import { getServerI18n } from "@/lib/i18n/server";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp, reserveAttempt } from "@/lib/security/rate-limit";

const noStore = { "cache-control": "no-store" };
const TIMING_EQUALISER_HASH = "$2b$10$zN1gFgiX48MtiTQ9xbwAjOBLnk7QFfVFoISIbd2r/jR2k.4gSTfmq";

export type GoogleSecurityDeps = {
  config: typeof readGoogleLoginConfig;
  context: typeof getAuthContext;
  status: typeof readGoogleLinkStatus;
  credentials: (userId: number) => Promise<{ email: string; password: string | null } | null>;
  rateLimit: typeof consumeRateLimit;
  reserve: typeof reserveAttempt;
  compare: (plain: string, hash: string) => Promise<boolean>;
  unlink: typeof unlinkGoogle;
  deliver: typeof deliverGoogleLinkEmailAfterResponse;
};
const defaultDeps: GoogleSecurityDeps = {
  config: readGoogleLoginConfig,
  context: getAuthContext,
  status: readGoogleLinkStatus,
  credentials: readAccountCredentials,
  rateLimit: consumeRateLimit,
  reserve: reserveAttempt,
  compare: (plain, hash) => bcrypt.compare(plain, hash),
  unlink: unlinkGoogle,
  deliver: deliverGoogleLinkEmailAfterResponse,
};

export async function handleGoogleStatus(req: Request, deps: GoogleSecurityDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const context = await deps.context(req);
    if (context === null) return authRequiredResponse(req);
    const status = await deps.status(context.user.id);
    if (!status) return authRequiredResponse(req);
    return NextResponse.json(status, { headers: noStore });
  } catch (error) {
    console.error("GOOGLE_STATUS_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function handleGoogleUnlink(req: Request, deps: GoogleSecurityDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const context = await deps.context(req);
    if (context === null) return authRequiredResponse(req);
    const { t } = await getServerI18n();

    const rl = await deps.rateLimit({ key: `auth:login:${getClientIp(req)}`, limit: 10, windowMs: 60_000 });
    if (!rl.allowed) return NextResponse.json({ code: "RATE_LIMITED", error: "יותר מדי ניסיונות. אפשר לנסות שוב בעוד דקה." }, { status: 429, headers: noStore });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof password !== "string" || !password || password.length > 128) {
      return NextResponse.json({ code: "INVALID_BODY", error: "יש להזין את הסיסמה של החשבון." }, { status: 400, headers: noStore });
    }

    const creds = await deps.credentials(context.user.id);
    if (!creds) return authRequiredResponse(req);
    if (!creds.password) {
      return NextResponse.json(
        { code: "PASSWORD_REQUIRED", error: "לחשבון אין סיסמה. כדי לנתק את Google צריך קודם לבחור סיסמה, אחרת לא תהיה דרך להתחבר." },
        { status: 409, headers: noStore }
      );
    }

    const normalized = normalizeEmail(creds.email);
    const attempt = await deps.reserve({ key: loginAccountRateKey(normalized), limit: LOGIN_FAILURE_POLICY.limit, windowMs: LOGIN_FAILURE_POLICY.windowMs });
    if (!attempt.allowed) {
      const s = Math.max(1, Math.ceil(attempt.retryAfterMs / 1000));
      return NextResponse.json({ code: "LOGIN_LOCKED", error: loginLockedMessage(attempt.retryAfterMs, t), retryAfterSeconds: s }, { status: 429, headers: { ...noStore, "Retry-After": String(s) } });
    }
    if (!(await deps.compare(password, creds.password ?? TIMING_EQUALISER_HASH))) {
      if (attempt.count >= LOGIN_FAILURE_POLICY.limit) {
        await attempt.lock(LOGIN_FAILURE_POLICY.lockMs);
        const s = Math.ceil(LOGIN_FAILURE_POLICY.lockMs / 1000);
        return NextResponse.json({ code: "LOGIN_LOCKED", error: loginLockedMessage(LOGIN_FAILURE_POLICY.lockMs, t), retryAfterSeconds: s }, { status: 429, headers: { ...noStore, "Retry-After": String(s) } });
      }
      return NextResponse.json({ code: "INVALID_PASSWORD", error: "הסיסמה שגויה." }, { status: 401, headers: noStore });
    }
    await attempt.clear();

    const removed = await deps.unlink(context.user.id, new Date());
    if (!removed) return NextResponse.json({ code: "NOT_LINKED", error: "החשבון לא מחובר ל־Google." }, { status: 409, headers: noStore });
    deps.deliver(removed.noticeEmailId, context.user.businessId);
    return NextResponse.json({ success: true }, { headers: noStore });
  } catch (error) {
    console.error("GOOGLE_UNLINK_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ code: "SERVER_ERROR", error: "הניתוק לא הושלם. אפשר לנסות שוב." }, { status: 500, headers: noStore });
  }
}

export async function GET(req: Request) {
  return handleGoogleStatus(req);
}

export async function POST(req: Request) {
  return handleGoogleUnlink(req);
}
