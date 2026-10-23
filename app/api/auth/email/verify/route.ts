import { NextResponse } from "next/server";

import { authMessage, emailTokenProblem } from "@/lib/auth/auth-messages";
import { getServerI18n } from "@/lib/i18n/server";
import { consumeEmailVerification, type VerifyOutcome } from "@/lib/auth/email-tokens";
import { scheduleDelivery } from "@/lib/email/transactional/schedule";
import type { Locale } from "@/lib/i18n/config";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Spend an email-verification link. Needs no session: the link is the proof (whoever opens it on any
 * device controls the address). The database stamps User.emailVerifiedAt in the same step that spends
 * the link. Not behind AUTH_EMAIL_VERIFICATION_ENABLED: a link already sent stays usable until it
 * expires.
 *
 * The first successful verification also records the account's WELCOME (deferred from signup) in the
 * same transaction; it is delivered after the response, like every other transactional email.
 */
export type VerifyDeps = {
  rateLimit: typeof consumeRateLimit;
  consume: (token: unknown, locale?: Locale) => Promise<VerifyOutcome>;
  schedule: (emailId: number, businessId: number) => void;
};

const defaultDeps: VerifyDeps = {
  rateLimit: consumeRateLimit,
  consume: (token, locale) => consumeEmailVerification(token, new Date(), locale),
  schedule: scheduleDelivery,
};
const NO_STORE = { "Cache-Control": "no-store" };

export async function handleVerify(req: Request, deps: VerifyDeps = defaultDeps): Promise<NextResponse> {
  const { t, locale } = await getServerI18n();
  try {
    const ip = getClientIp(req);
    const rl = await deps.rateLimit({ key: `auth:link:consume:${ip}`, limit: 20, windowMs: 15 * 60_000 });
    if (!rl.allowed) {
      return NextResponse.json({ error: authMessage("rateLimited", t), code: "RATE_LIMITED" }, { status: 429, headers: NO_STORE });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: authMessage("invalidBody", t), code: "INVALID_BODY" }, { status: 400, headers: NO_STORE });
    }
    const outcome = await deps.consume((body as { token?: unknown } | null)?.token, locale);
    if (outcome.status === "VERIFIED") {
      if (outcome.welcomeEmailId !== null) {
        try {
          deps.schedule(outcome.welcomeEmailId, outcome.businessId);
        } catch (error) {
          console.error("[transactional-email] schedule_failed", {
            id: outcome.welcomeEmailId,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      return NextResponse.json({ ok: true, message: authMessage("emailVerified", t) }, { headers: NO_STORE });
    }
    return NextResponse.json(emailTokenProblem(outcome.status, t), { status: 400, headers: NO_STORE });
  } catch (error) {
    console.error("[auth] verify_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: authMessage("serverError", t), code: "SERVER_ERROR" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleVerify(req);
}
