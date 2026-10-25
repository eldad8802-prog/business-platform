import { NextResponse, after } from "next/server";
import { randomUUID } from "node:crypto";

import { clearTicketCookie, GOOGLE_TICKET_COOKIE, readCookie, readGoogleLoginConfig } from "@/lib/auth/google-oauth";
import { readSignupTicket, SignupTicketRefusedError } from "@/lib/auth/oauth-ticket";
import { checkBrowserCsrf, setRefreshCookie } from "@/lib/auth/refresh-cookie";
import {
  createAccountFromGoogle,
  EmailAlreadyRegisteredError,
  SignupValidationError,
  type CreateGoogleAccountInput,
  type CreatedGoogleAccount,
} from "@/lib/auth/signup";
import { isPublicSignupEnabled, SIGNUP_DISABLED_STATUS, signupDisabledBody } from "@/lib/auth/signup-gate";
import { readSignupAllowlist } from "@/lib/auth/signup-allowlist";
import { isHoneypotFilled } from "@/lib/auth/signup-honeypot";
import { normalizeGoogleSignupInput } from "@/lib/auth/signup-identity";
import { authMessage } from "@/lib/auth/auth-messages";
import { isTransactionalEmailEnabled } from "@/lib/email/transactional/config";
import { deliverTransactionalEmail } from "@/lib/email/transactional/delivery";
import { getServerI18n } from "@/lib/i18n/server";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import { runTenantJob } from "@/lib/tenant/job";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google" — step 3: the person completes the EXISTING signup (name, business name, the
 * required consent) and only now does an account exist.
 *
 * The public-signup gate is evaluated FIRST, before the body is read and before the rate limiter, exactly as
 * in /api/auth/register — with signup closed only a closed-beta address passes, and the address is the
 * ticket's (provider-verified), never one the visitor typed. The rate limit is the register route's own key:
 * Google is not a way around it. Then the fields are validated (an invalid form spends nothing), and
 * createAccountFromGoogle writes the whole account in ONE transaction that starts by spending the ticket.
 *
 * The response carries no token: it sets the same httpOnly refresh cookie login sets, and the page fetches
 * its access token from /api/auth/refresh. OFF → 404.
 */
export type CompleteDeps = {
  config: typeof readGoogleLoginConfig;
  isSignupEnabled: () => boolean;
  signupAllowlist: typeof readSignupAllowlist;
  readTicket: typeof readSignupTicket;
  rateLimit: typeof consumeRateLimit;
  createAccount: (input: CreateGoogleAccountInput) => Promise<CreatedGoogleAccount>;
  recordUsage: typeof recordProductUsageEvent;
  scheduleWelcome: (emailId: number, businessId: number) => void;
};

function scheduleWelcomeAfterResponse(emailId: number, businessId: number): void {
  if (!isTransactionalEmailEnabled()) return;
  after(() => runTenantJob({ businessId }, async () => { await deliverTransactionalEmail(emailId); }));
}

const defaultDeps: CompleteDeps = {
  config: readGoogleLoginConfig,
  isSignupEnabled: isPublicSignupEnabled,
  signupAllowlist: readSignupAllowlist,
  readTicket: readSignupTicket,
  rateLimit: consumeRateLimit,
  createAccount: createAccountFromGoogle,
  recordUsage: recordProductUsageEvent,
  scheduleWelcome: scheduleWelcomeAfterResponse,
};

const noStore = { "cache-control": "no-store" };

function signupDisabled(): NextResponse {
  return NextResponse.json(signupDisabledBody(), { status: SIGNUP_DISABLED_STATUS, headers: noStore });
}

/** Spent, expired, superseded or unknown: the browser forgets it; the person starts again with Google. */
function ticketGone(): NextResponse {
  const res = NextResponse.json(
    { code: "TICKET_REFUSED", error: "תוקף ההרשמה עם Google פג או שכבר הושלמה. אפשר להתחיל שוב." },
    { status: 409, headers: noStore }
  );
  clearTicketCookie(res);
  return res;
}

export async function handleGoogleComplete(req: Request, deps: CompleteDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.config()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { t, locale } = await getServerI18n();
  const failed = (reason: string) =>
    deps.recordUsage({
      businessId: null,
      userId: null,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
      action: PRODUCT_USAGE_ACTIONS.FAILED,
      outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
      metadata: { reason, method: "google" },
    });

  try {
    if (!checkBrowserCsrf(req).ok) return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: noStore });

    const secret = readCookie(req, GOOGLE_TICKET_COOKIE);

    // --- Public-signup gate: first, before the body and the rate limiter (as in /api/auth/register). ---
    if (!deps.isSignupEnabled()) {
      const list = deps.signupAllowlist();
      if (!list.configured) return signupDisabled();
      const view = await deps.readTicket(secret);
      if (!view || !list.has(view.email)) return signupDisabled();
    }

    const rl = await deps.rateLimit({ key: `auth:register:${getClientIp(req)}`, limit: 3, windowMs: 60 * 60_000 });
    if (!rl.allowed) {
      await failed("rate_limited");
      return NextResponse.json({ error: authMessage("rateLimited", t), code: "RATE_LIMITED" }, { status: 429, headers: noStore });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      await failed("malformed_body");
      return NextResponse.json({ error: authMessage("invalidBody", t), code: "INVALID_BODY" }, { status: 400, headers: noStore });
    }
    if (isHoneypotFilled(body)) {
      await failed("honeypot");
      return NextResponse.json({ error: authMessage("signupRejected", t), code: "SIGNUP_REJECTED" }, { status: 400, headers: noStore });
    }
    const input = normalizeGoogleSignupInput(body as never);

    const now = new Date();
    const account = await deps.createAccount({
      ticketSecret: secret,
      name: input.name,
      businessName: input.businessName,
      attribution: input.attribution,
      now,
      userAgent: req.headers.get("user-agent"),
      locale,
    });

    await deps.recordUsage({
      businessId: account.businessId,
      userId: account.userId,
      sessionId: randomUUID(),
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
      metadata: { method: "google" },
    });

    const res = NextResponse.json({ success: true, next: "/setup" }, { headers: noStore });
    setRefreshCookie(res, account.session.credential, { now, absoluteExpiresAt: account.session.absoluteExpiresAt });
    clearTicketCookie(res);
    if (account.welcomeEmailId !== null) {
      try {
        deps.scheduleWelcome(account.welcomeEmailId, account.businessId);
      } catch (error) {
        console.error("[transactional-email] schedule_failed", { id: account.welcomeEmailId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
    return res;
  } catch (error) {
    if (error instanceof SignupValidationError) {
      await failed(`invalid_${error.field}`);
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400, headers: noStore });
    }
    if (error instanceof SignupTicketRefusedError) {
      await failed("ticket_refused");
      return ticketGone();
    }
    if (error instanceof EmailAlreadyRegisteredError) {
      await failed("duplicate_email");
      const res = NextResponse.json(
        { code: "EMAIL_ALREADY_REGISTERED", error: "כבר קיים חשבון עם הכתובת הזו. אפשר להתחבר עם האימייל והסיסמה." },
        { status: 409, headers: noStore }
      );
      clearTicketCookie(res);
      return res;
    }
    console.error("GOOGLE_COMPLETE_ERROR:", safeErrorSummary(error));
    await failed("server_error");
    return NextResponse.json({ error: authMessage("serverError", t), code: "SERVER_ERROR" }, { status: 500, headers: noStore });
  }
}

export async function POST(req: Request) {
  return handleGoogleComplete(req);
}
