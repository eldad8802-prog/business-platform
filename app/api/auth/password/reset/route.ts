import { NextResponse } from "next/server";

import { AUTH_MESSAGES_HE, emailTokenProblem } from "@/lib/auth/auth-messages";
import { consumePasswordReset, type ResetOutcome } from "@/lib/auth/email-tokens";
import { clearRefreshCookie } from "@/lib/auth/refresh-cookie";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/signup-identity";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Choose a new password with a reset link. The link is the authority — checked, spent and acted on in
 * the database in one step (auth_password_reset_consume): the password is set, every access token and
 * every refresh session of the account dies, and the account's other reset links close. Nobody is
 * signed in by this: the owner signs in with the new password, on every device.
 *
 * Not behind AUTH_PASSWORD_RESET_ENABLED: a link already sent stays usable until it expires.
 */
export type ResetDeps = {
  rateLimit: typeof consumeRateLimit;
  consume: (token: unknown, password: unknown) => Promise<ResetOutcome>;
};

const defaultDeps: ResetDeps = { rateLimit: consumeRateLimit, consume: consumePasswordReset };
const NO_STORE = { "Cache-Control": "no-store" };

export async function handleReset(req: Request, deps: ResetDeps = defaultDeps): Promise<NextResponse> {
  try {
    const ip = getClientIp(req);
    const rl = await deps.rateLimit({ key: `auth:link:consume:${ip}`, limit: 20, windowMs: 15 * 60_000 });
    if (!rl.allowed) {
      return NextResponse.json({ error: AUTH_MESSAGES_HE.rateLimited, code: "RATE_LIMITED" }, { status: 429, headers: NO_STORE });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: AUTH_MESSAGES_HE.invalidBody, code: "INVALID_BODY" }, { status: 400, headers: NO_STORE });
    }
    const { token, password } = (body ?? {}) as { token?: unknown; password?: unknown };
    const outcome = await deps.consume(token, password);

    if (outcome.status === "RESET") {
      const res = NextResponse.json({ ok: true, message: AUTH_MESSAGES_HE.resetDone }, { headers: NO_STORE });
      // Every session of the account was just revoked; this browser's cookie names one of them.
      clearRefreshCookie(res);
      return res;
    }
    if (outcome.status === "WEAK_PASSWORD") {
      return NextResponse.json(
        { error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`, field: "password", code: "WEAK_PASSWORD" },
        { status: 400, headers: NO_STORE }
      );
    }
    return NextResponse.json(emailTokenProblem(outcome.status), { status: 400, headers: NO_STORE });
  } catch (error) {
    console.error("[auth] reset_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: AUTH_MESSAGES_HE.serverError, code: "SERVER_ERROR" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleReset(req);
}
