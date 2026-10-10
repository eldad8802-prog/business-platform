import { NextResponse, after } from "next/server";
import { randomUUID } from "node:crypto";

import { AuthTokenConfigError, signAuthToken } from "@/lib/auth";
import { setRefreshCookie } from "@/lib/auth/refresh-cookie";
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
import { readSignupAllowlist, type SignupAllowlist } from "@/lib/auth/signup-allowlist";
import type { NormalizedSignup } from "@/lib/auth/signup";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { isTransactionalEmailEnabled } from "@/lib/email/transactional/config";
import { deliverTransactionalEmail } from "@/lib/email/transactional/delivery";
import { runTenantJob } from "@/lib/tenant/job";
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
 *
 * And it is the SAME session login returns: an AuthSession row written in the
 * account's own transaction, an access token that names it, and the httpOnly
 * refresh cookie. A new owner is refreshable, listed among their devices and
 * revocable on their own — there is one kind of authenticated user, not two.
 */
export type RegisterDeps = {
  isSignupEnabled: () => boolean;
  /**
   * The closed-beta allowlist (lib/auth/signup-allowlist.ts). Consulted ONLY
   * while public signup is closed; fail-closed — not configured means no one.
   */
  signupAllowlist: () => SignupAllowlist;
  rateLimit: typeof consumeRateLimit;
  hashPassword: (plain: string) => Promise<string>;
  /**
   * Atomic: Business, User and the first AuthSession, or nothing. Throws
   * EmailAlreadyRegisteredError when the unique index rejects.
   */
  createAccount: (input: CreateAccountInput) => Promise<CreatedAccount>;
  /** The session id is required: a token that names no session is never minted. */
  signToken: (userId: number, tokenVersion: number, sessionId: string) => string;
  /**
   * Usage telemetry. Injected so the route stays testable without a database —
   * the real implementation swallows its own errors, but it still opens a
   * connection, which a pure dependency-injection test must not do.
   */
  recordUsage: typeof recordProductUsageEvent;
  /**
   * The fast path for the WELCOME the account transaction recorded: delivery is
   * scheduled to run AFTER the response. It never blocks, fails or delays the
   * signup — the sweep is what guarantees delivery (or its expiry) when this
   * attempt does not happen or does not succeed.
   */
  scheduleWelcome: (welcomeEmailId: number, businessId: number) => void;
};

function scheduleWelcomeAfterResponse(welcomeEmailId: number, businessId: number): void {
  // OFF: nothing is scheduled at all — no database read, no outbound request.
  if (!isTransactionalEmailEnabled()) return;
  // An explicit tenant handoff (CI-W4-1), never the request's inherited context.
  // Delivery itself runs on the signup / delivery plane and reads only its row.
  after(() =>
    runTenantJob({ businessId }, async () => {
      await deliverTransactionalEmail(welcomeEmailId);
    })
  );
}

const defaultDeps: RegisterDeps = {
  isSignupEnabled: isPublicSignupEnabled,
  signupAllowlist: readSignupAllowlist,
  rateLimit: consumeRateLimit,
  hashPassword: hashSignupPassword,
  createAccount,
  signToken: signAuthToken,
  recordUsage: recordProductUsageEvent,
  scheduleWelcome: scheduleWelcomeAfterResponse,
};

/** The one answer every closed path gives — byte-for-byte the gate's response. */
function signupDisabledResponse(): NextResponse {
  return NextResponse.json(signupDisabledBody(), {
    status: SIGNUP_DISABLED_STATUS,
    headers: { "Cache-Control": "no-store" },
  });
}

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
  // Set only on the closed-beta path, where the answers below must stay those of
  // a closed gate for anything that is not a successful signup of a listed address.
  let admitted: NormalizedSignup | null = null;
  try {
    // --- Public-signup gate: fail closed, before any side effect. ---
    if (!deps.isSignupEnabled()) {
      const allowlist = deps.signupAllowlist();
      if (allowlist.error) {
        // Ignored as a whole (fail closed). Counts and a code only — never an address.
        console.warn("[signup] allowlist ignored", { error: allowlist.error });
      }
      // No (valid) list: exactly the closed gate — before the body is read.
      if (!allowlist.configured) return signupDisabledResponse();
      admitted = await admitAllowlisted(req, allowlist);
      if (!admitted) return signupDisabledResponse();
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

    let input: NormalizedSignup;
    if (admitted) {
      input = admitted;
    } else {
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
      input = normalizeSignupInput(body as never);
    }
    const passwordHash = await deps.hashPassword(input.password);

    const now = new Date();
    const account = await deps.createAccount({
      email: input.email,
      passwordHash,
      name: input.name,
      businessName: input.businessName,
      now,
      userAgent: req.headers.get("user-agent"),
      attribution: input.attribution,
    });

    // Minted before any bookkeeping below, so a failure there can never cost the
    // owner the session they just earned. It names the session row, exactly as
    // login's token does.
    const token = deps.signToken(
      account.userId,
      account.tokenVersion,
      account.session.sessionId
    );
    // Telemetry correlation id, as in login — NOT the AuthSession id.
    const sessionId = randomUUID();

    await deps.recordUsage({
      businessId: account.businessId,
      userId: account.userId,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    const res = NextResponse.json({
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

    // The same httpOnly refresh credential login sets, with the same lifetime.
    setRefreshCookie(res, account.session.credential, {
      now,
      absoluteExpiresAt: account.session.absoluteExpiresAt,
    });

    // Last, and contained: the account and its session are done. Nothing about
    // the email — scheduling included — may turn a successful signup into an error.
    if (account.welcomeEmailId !== null) {
      try {
        deps.scheduleWelcome(account.welcomeEmailId, account.businessId);
      } catch (error) {
        console.error("[transactional-email] schedule_failed", {
          id: account.welcomeEmailId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }

    return res;
  } catch (error) {
    if (error instanceof SignupValidationError) {
      await recordSignupFailure(deps, `invalid_${error.field}`);
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status: 400 }
      );
    }

    if (error instanceof EmailAlreadyRegisteredError) {
      // Closed beta: a listed address that already has an account answers as the
      // closed gate does — "registered" must not be learnable from outside.
      if (admitted) return signupDisabledResponse();
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

/**
 * Closed beta: is this a valid signup for an allowlisted address? Returns the
 * normalised input, or null. A malformed body, an invalid field and an address
 * that is not listed are deliberately indistinguishable — the caller answers all
 * three with the closed gate's response, so nobody can learn from the reply
 * whether an address is on the list. Nothing is recorded and no rate-limit budget
 * is spent for a request that is not admitted, exactly as with no list at all.
 */
async function admitAllowlisted(req: Request, allowlist: SignupAllowlist): Promise<NormalizedSignup | null> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return null;
  }
  let input: NormalizedSignup;
  try {
    input = normalizeSignupInput(body as never);
  } catch {
    return null;
  }
  return allowlist.has(input.email) ? input : null;
}

export async function POST(req: Request) {
  return handleRegister(req);
}
