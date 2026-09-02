import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { AuthTokenConfigError, signAuthToken } from "@/lib/auth";
import {
  EmailAlreadyRegisteredError,
  SignupValidationError,
  createAccount,
  hashSignupPassword,
  normalizeSignupInput,
  type CreateAccountInput,
  type CreatedAccount,
} from "@/lib/auth/signup";
import {
  SIGNUP_DISABLED_STATUS,
  isPublicSignupEnabled,
  signupDisabledBody,
} from "@/lib/auth/signup-gate";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";

export const dynamic = "force-dynamic";

/**
 * Registration is the ONLY path in the product that creates a User + Business.
 * It is therefore the single server-side choke point for the public-signup
 * gate (`PUBLIC_SIGNUP_ENABLED`, see lib/auth/signup-gate.ts).
 *
 * The gate is the FIRST thing evaluated — before the body is parsed, before the
 * rate limiter, before any database call — so a blocked attempt can never leave
 * a partial User or Business behind, and can never consume rate-limit budget or
 * DB connections. Login is deliberately untouched: existing users are never
 * affected by this flag.
 *
 * BEHIND the gate, account creation is atomic. `Business` and its first `User`
 * used to be two separate writes: when the second failed the first stayed, and
 * the result was a tenant nobody could ever log into. They are now one
 * transaction. There is also no pre-flight duplicate lookup — a check followed
 * by a write can be raced, and the loser surfaced as a 500. The unique index is
 * the arbiter, and its rejection becomes a 409 that names the field.
 *
 * A successful signup returns the SESSION as well. The client used to call this
 * and then call /api/auth/login separately; when that second call failed the
 * account existed but the owner was told "שגיאה בהתחברות", and retrying said the
 * user already existed — a dead end with no way out. There is no second call.
 */
export type RegisterDeps = {
  isSignupEnabled: () => boolean;
  rateLimit: typeof consumeRateLimit;
  hashPassword: (plain: string) => Promise<string>;
  /** Atomic. Throws EmailAlreadyRegisteredError when the unique index rejects. */
  createAccount: (input: CreateAccountInput) => Promise<CreatedAccount>;
  signToken: (userId: number, tokenVersion: number) => string;
  /**
   * Usage telemetry. Injected so the route stays testable without a database —
   * the real implementation swallows its own errors, but it still opens a
   * connection, which a pure dependency-injection test must not do.
   */
  recordUsage: typeof recordProductUsageEvent;
};

const defaultDeps: RegisterDeps = {
  isSignupEnabled: isPublicSignupEnabled,
  rateLimit: consumeRateLimit,
  hashPassword: hashSignupPassword,
  createAccount,
  signToken: signAuthToken,
  recordUsage: recordProductUsageEvent,
};

async function recordSignupFailure(
  deps: RegisterDeps,
  reason: string
) {
  await deps.recordUsage({
    businessId: null,
    userId: null,
    featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
    action: PRODUCT_USAGE_ACTIONS.FAILED,
    outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
    metadata: { reason },
  });
}

export async function handleRegister(
  req: Request,
  deps: RegisterDeps = defaultDeps
): Promise<NextResponse> {
  try {
    // --- Public-signup gate: fail closed, before any side effect. ---
    if (!deps.isSignupEnabled()) {
      return NextResponse.json(signupDisabledBody(), {
        status: SIGNUP_DISABLED_STATUS,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const ip = getClientIp(req);
    const rl = await deps.rateLimit({
      key: `auth:register:${ip}`,
      limit: 3,
      windowMs: 60 * 60_000,
    });

    if (!rl.allowed) {
      await recordSignupFailure(deps, "rate_limited");
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      await recordSignupFailure(deps, "malformed_body");
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const input = normalizeSignupInput(body as never);
    const passwordHash = await deps.hashPassword(input.password);

    const account = await deps.createAccount({
      email: input.email,
      passwordHash,
      name: input.name,
      businessName: input.businessName,
    });

    // Minted before any bookkeeping below, so a failure there can never cost the
    // owner the session they just earned.
    const token = deps.signToken(account.userId, account.tokenVersion);
    const sessionId = randomUUID();

    await deps.recordUsage({
      businessId: account.businessId,
      userId: account.userId,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    return NextResponse.json({
      success: true,
      // Retained from the previous contract so an older client build keeps
      // working through a rolling deploy.
      userId: account.userId,
      businessId: account.businessId,
      token,
      sessionId,
      user: {
        id: account.userId,
        email: account.email,
        name: account.name,
        businessId: account.businessId,
        businessName: account.businessName,
      },
    });
  } catch (error) {
    if (error instanceof SignupValidationError) {
      await recordSignupFailure(deps, `invalid_${error.field}`);
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status: 400 }
      );
    }

    if (error instanceof EmailAlreadyRegisteredError) {
      await recordSignupFailure(deps, "duplicate_email");
      // 409 states the specific truth: the request was well-formed, it lost to
      // an existing account. The old code returned 400 after a racy pre-check,
      // or 500 when the race was lost at the index.
      return NextResponse.json(
        {
          error: "כתובת האימייל הזו כבר רשומה במערכת",
          field: "email",
          code: "EMAIL_ALREADY_REGISTERED",
        },
        { status: 409 }
      );
    }

    if (error instanceof AuthTokenConfigError) {
      // The account exists at this point; only the session could not be minted.
      // Say so plainly rather than implying the signup failed.
      console.error("REGISTER_ERROR:", error.message);
      await recordSignupFailure(deps, "auth_token_misconfigured");
      return NextResponse.json(
        {
          error:
            process.env.NODE_ENV === "production"
              ? "Server configuration error"
              : error.message,
        },
        { status: 503 }
      );
    }

    console.error("REGISTER_ERROR:", error);
    await recordSignupFailure(deps, "server_error");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handleRegister(req);
}
