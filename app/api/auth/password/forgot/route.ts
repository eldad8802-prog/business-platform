import { NextResponse, after } from "next/server";

import { isPasswordResetEnabled } from "@/lib/auth/account-recovery-config";
import { RESET_REQUEST_ACCOUNT_LIMIT, resetRequestAccountRateKey } from "@/lib/auth/account-rate-key";
import { AUTH_MESSAGES_HE } from "@/lib/auth/auth-messages";
import { requestPasswordReset, type IssuedLink } from "@/lib/auth/email-tokens";
import { EMAIL_SHAPE, normalizeEmail } from "@/lib/auth/signup-identity";
import { isTransactionalEmailEnabled } from "@/lib/email/transactional/config";
import { deliverTransactionalEmail } from "@/lib/email/transactional/delivery";
import { runTenantJob } from "@/lib/tenant/job";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Forgot password" — request a reset link.
 *
 * The answer never depends on the address: a registered address, an unknown one, a business in
 * deletion, the per-address limit — all get the same 200 and the same words, and the lookup, the
 * token and the email all happen AFTER the response, so not even the response time tells them apart.
 * Only the per-IP limit answers differently (429), and it says nothing about any address.
 */
export type ForgotDeps = {
  enabled: () => boolean;
  rateLimit: typeof consumeRateLimit;
  request: (email: string, now: Date) => Promise<IssuedLink | null>;
  deliver: (emailId: number, businessId: number) => Promise<void>;
  defer: (work: () => Promise<void>) => void;
};

/**
 * The continuation after the response: the lookup and the token run on the auth plane (no tenant —
 * the requester is not signed in), and the delivery gets an EXPLICIT tenant handoff to the business
 * the link was issued for (CI-W4-1), never anything inherited from the request.
 */
async function deliverForBusiness(emailId: number, businessId: number): Promise<void> {
  if (!isTransactionalEmailEnabled()) return;
  await runTenantJob({ businessId }, async () => {
    await deliverTransactionalEmail(emailId);
  });
}

const defaultDeps: ForgotDeps = {
  enabled: isPasswordResetEnabled,
  rateLimit: consumeRateLimit,
  request: requestPasswordReset,
  deliver: deliverForBusiness,
  defer: (work) => after(work),
};

const NO_STORE = { "Cache-Control": "no-store" };

export async function handleForgot(req: Request, deps: ForgotDeps = defaultDeps): Promise<NextResponse> {
  if (!deps.enabled()) {
    return NextResponse.json({ error: AUTH_MESSAGES_HE.featureUnavailable, code: "FEATURE_DISABLED" }, { status: 404, headers: NO_STORE });
  }

  const ip = getClientIp(req);
  const rl = await deps.rateLimit({ key: `auth:reset:ip:${ip}`, limit: 5, windowMs: 15 * 60_000 });
  if (!rl.allowed) {
    return NextResponse.json({ error: AUTH_MESSAGES_HE.rateLimited, code: "RATE_LIMITED" }, { status: 429, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: AUTH_MESSAGES_HE.invalidBody, code: "INVALID_BODY" }, { status: 400, headers: NO_STORE });
  }
  const email = (body as { email?: unknown } | null)?.email;
  if (typeof email !== "string" || email.length > 320 || !EMAIL_SHAPE.test(email.trim())) {
    return NextResponse.json(
      { error: "יש להזין כתובת אימייל תקינה", field: "email", code: "INVALID_EMAIL" },
      { status: 400, headers: NO_STORE }
    );
  }

  // Per address, from anywhere. Spent before anything is looked up, and an exhausted
  // address gets the very same answer — it only means no new link goes out.
  const perAddress = await deps.rateLimit({ key: resetRequestAccountRateKey(normalizeEmail(email)), ...RESET_REQUEST_ACCOUNT_LIMIT });
  if (perAddress.allowed) {
    deps.defer(async () => {
      try {
        const link = await deps.request(email, new Date());
        if (link) await deps.deliver(link.emailId, link.businessId);
      } catch (error) {
        console.error("[auth] reset_request_failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    });
  }

  return NextResponse.json({ ok: true, message: AUTH_MESSAGES_HE.resetRequested }, { status: 200, headers: NO_STORE });
}

export async function POST(req: Request) {
  return handleForgot(req);
}
