import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isEmailVerificationEnabled } from "@/lib/auth/account-recovery-config";
import { authMessage } from "@/lib/auth/auth-messages";
import { getServerI18n } from "@/lib/i18n/server";
import { requestEmailVerification, type VerificationRequest } from "@/lib/auth/email-tokens";
import { scheduleDelivery } from "@/lib/email/transactional/schedule";
import type { Locale } from "@/lib/i18n/config";
import { getServerI18n } from "@/lib/i18n/server";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Send the verification link again" — for the signed-in owner, to their own address only (the
 * address comes from their account row, never from the request). A new link supersedes the previous
 * one. Bounded per user here (3 / hour) and in the database (5 links per user and hour).
 */
export type ResendDeps = {
  enabled: () => boolean;
  currentUser: (req: Request) => Promise<{ id: number } | null>;
  rateLimit: typeof consumeRateLimit;
  request: (userId: number, now: Date, locale?: Locale) => Promise<VerificationRequest>;
  schedule: (emailId: number, businessId: number) => void;
};

const defaultDeps: ResendDeps = {
  enabled: isEmailVerificationEnabled,
  currentUser: getCurrentUser,
  rateLimit: consumeRateLimit,
  request: requestEmailVerification,
  schedule: scheduleDelivery,
};
const NO_STORE = { "Cache-Control": "no-store" };

export async function handleResend(req: Request, deps: ResendDeps = defaultDeps): Promise<NextResponse> {
  const { t } = await getServerI18n();
  try {
    const user = await deps.currentUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    if (!deps.enabled()) {
      return NextResponse.json({ error: authMessage("featureUnavailable", t), code: "FEATURE_DISABLED" }, { status: 404, headers: NO_STORE });
    }
    const rl = await deps.rateLimit({ key: `auth:verify:resend:user:${user.id}`, limit: 3, windowMs: 60 * 60_000 });
    if (!rl.allowed) {
      return NextResponse.json({ error: authMessage("rateLimited", t), code: "RATE_LIMITED" }, { status: 429, headers: NO_STORE });
    }
    const { locale } = await getServerI18n();
    const result = await deps.request(user.id, new Date(), locale);
    if (result.status === "ALREADY_VERIFIED") {
      return NextResponse.json({ ok: true, alreadyVerified: true, message: authMessage("alreadyVerified", t) }, { headers: NO_STORE });
    }
    if (result.status === "NOT_ISSUED") {
      return NextResponse.json({ error: authMessage("rateLimited", t), code: "RATE_LIMITED" }, { status: 429, headers: NO_STORE });
    }
    try {
      deps.schedule(result.link.emailId, result.link.businessId);
    } catch (error) {
      console.error("[transactional-email] schedule_failed", { id: result.link.emailId, error: error instanceof Error ? error.name : "unknown" });
    }
    return NextResponse.json({ ok: true, message: authMessage("verificationSent", t) }, { headers: NO_STORE });
  } catch (error) {
    console.error("[auth] resend_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: authMessage("serverError", t), code: "SERVER_ERROR" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  return handleResend(req);
}
