/**
 * Signup endpoint.
 *
 * Creates the business and its first owner atomically and returns an
 * authenticated session in the same response. The client used to call this and
 * then immediately call `/api/auth/login` with the same credentials; when that
 * second call failed the account existed but the owner was told "שגיאה
 * בהתחברות", and retrying gave them "User already exists" — a dead end they
 * could not get out of. A signup that has succeeded must never leave the person
 * who performed it unable to proceed.
 */

import { NextResponse } from "next/server";

import { randomUUID } from "node:crypto";

import { AuthTokenConfigError, signAuthToken } from "@/lib/auth";
import {
  EmailAlreadyRegisteredError,
  SignupValidationError,
  createAccount,
  normalizeSignupInput,
} from "@/lib/auth/signup";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";

export const dynamic = "force-dynamic";

async function recordSignupFailure(reason: string) {
  await recordProductUsageEvent({
    businessId: null,
    userId: null,
    featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
    action: PRODUCT_USAGE_ACTIONS.FAILED,
    outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
    metadata: { reason },
  });
}

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = await consumeRateLimit({
      key: `auth:register:${ip}`,
      limit: 3,
      windowMs: 60 * 60_000,
    });

    if (!rl.allowed) {
      await recordSignupFailure("rate_limited");
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      await recordSignupFailure("malformed_body");
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const input = normalizeSignupInput(body as never);
    const account = await createAccount(input);

    // Issued before any non-essential work below, so a failure in bookkeeping
    // can never cost the owner the session they just earned.
    const token = signAuthToken(account.userId, account.tokenVersion);
    const sessionId = randomUUID();

    await recordProductUsageEvent({
      businessId: account.businessId,
      userId: account.userId,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    return NextResponse.json({
      success: true,
      // `userId` / `businessId` are retained from the previous contract so an
      // older client build keeps working through a rolling deploy.
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
      await recordSignupFailure(`invalid_${error.field}`);
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status: 400 }
      );
    }

    if (error instanceof EmailAlreadyRegisteredError) {
      await recordSignupFailure("duplicate_email");
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
      await recordSignupFailure("auth_token_misconfigured");
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
    await recordSignupFailure("server_error");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
