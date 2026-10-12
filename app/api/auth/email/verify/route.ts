import { NextResponse } from "next/server";

import { AUTH_MESSAGES_HE, emailTokenProblem } from "@/lib/auth/auth-messages";
import { consumeEmailVerification, type VerifyOutcome } from "@/lib/auth/email-tokens";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Spend an email-verification link. Needs no session: the link is the proof (whoever opens it on any
 * device controls the address). The database stamps User.emailVerifiedAt in the same step that spends
 * the link. Not behind AUTH_EMAIL_VERIFICATION_ENABLED: a link already sent stays usable until it
 * expires.
 */
export type VerifyDeps = {
  rateLimit: typeof consumeRateLimit;
  consume: (token: unknown) => Promise<VerifyOutcome>;
};

const defaultDeps: VerifyDeps = { rateLimit: consumeRateLimit, consume: consumeEmailVerification };
const NO_STORE = { "Cache-Control": "no-store" };

export async function handleVerify(req: Request, deps: VerifyDeps = defaultDeps): Promise<NextResponse> {
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
    const outcome = await deps.consume((body as { token?: unknown } | null)?.token);
    if (outcome.status === "VERIFIED") {
      return NextResponse.json({ ok: true, message: AUTH_MESSAGES_HE.emailVerified }, { headers: NO_STORE });
    }
    return NextResponse.json(emailTokenProblem(outcome.status), { status: 400, headers: NO_STORE });
  } catch (error) {
    console.error("[auth] verify_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: AUTH_MESSAGES_HE.serverError, code: "SERVER_ERROR" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleVerify(req);
}
