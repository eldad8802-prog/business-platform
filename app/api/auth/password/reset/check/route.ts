import { NextResponse } from "next/server";

import { AUTH_MESSAGES_HE, emailTokenProblem, type EmailTokenStatus } from "@/lib/auth/auth-messages";
import { checkAccountLink } from "@/lib/auth/email-tokens";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Is this reset link still usable? Lets the page say "expired / already used" before the owner types a
 * new password. Answers only about the link the caller holds; changes nothing.
 */
export type CheckDeps = {
  rateLimit: typeof consumeRateLimit;
  check: (token: unknown) => Promise<EmailTokenStatus>;
};

const defaultDeps: CheckDeps = {
  rateLimit: consumeRateLimit,
  check: (token) => checkAccountLink(token, "PASSWORD_RESET"),
};
const NO_STORE = { "Cache-Control": "no-store" };

export async function handleResetCheck(req: Request, deps: CheckDeps = defaultDeps): Promise<NextResponse> {
  try {
    const ip = getClientIp(req);
    const rl = await deps.rateLimit({ key: `auth:link:check:${ip}`, limit: 30, windowMs: 15 * 60_000 });
    if (!rl.allowed) {
      return NextResponse.json({ error: AUTH_MESSAGES_HE.rateLimited, code: "RATE_LIMITED" }, { status: 429, headers: NO_STORE });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: AUTH_MESSAGES_HE.invalidBody, code: "INVALID_BODY" }, { status: 400, headers: NO_STORE });
    }
    const status = await deps.check((body as { token?: unknown } | null)?.token);
    if (status === "VALID") return NextResponse.json({ ok: true, status }, { headers: NO_STORE });
    return NextResponse.json({ ok: false, status, ...emailTokenProblem(status) }, { headers: NO_STORE });
  } catch (error) {
    console.error("[auth] link_check_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: AUTH_MESSAGES_HE.serverError, code: "SERVER_ERROR" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleResetCheck(req);
}
