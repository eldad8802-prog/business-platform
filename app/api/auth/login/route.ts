export const dynamic = "force-dynamic";

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { authDb } from "@/lib/prisma-auth";
import { AuthTokenConfigError, signAuthToken } from "@/lib/auth";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import bcrypt from "bcrypt";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { issueRefreshSession } from "@/lib/auth/refresh-session";
import { setRefreshCookie } from "@/lib/auth/refresh-cookie";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";
import { recordSecurityEvent } from "@/lib/security/security-events";

async function recordLoginFailure(input: {
  businessId?: number | null;
  userId?: number | null;
  reason: string;
}) {
  await recordSecurityEvent({ type: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", reason: input.reason, businessId: input.businessId, userId: input.userId, actor: "ANONYMOUS" });
  await recordProductUsageEvent({
    businessId: input.businessId ?? null,
    userId: input.userId ?? null,
    featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGIN,
    action: PRODUCT_USAGE_ACTIONS.FAILED,
    outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
    metadata: { reason: input.reason },
  });
}

/**
 * Exactly what login consumes: the hash for the comparison, the id and version
 * the token is minted from, the tenant it resolves to, and the fields the
 * response echoes back.
 */
const LOGIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  password: true,
  businessId: true,
  tokenVersion: true,
  business: { select: { name: true } },
} as const;

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = await consumeRateLimit({
      key: `auth:login:${ip}`,
      limit: 10,
      windowMs: 60_000,
    });

    if (!rl.allowed) {
      await recordLoginFailure({ reason: "rate_limited" });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const body = await req.json();
    const { email, password } = body;

    // Typed rather than merely truthy: a non-string email reached the folding
    // step below and threw, which surfaced as a 500 on what is really a bad
    // request.
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email ||
      !password
    ) {
      await recordLoginFailure({ reason: "missing_credentials" });
      return NextResponse.json(
        { error: "Missing email or password" },
        { status: 400 }
      );
    }

    // Named once and used by both lookups, so the fallback can never drift into
    // selecting a different set from the primary path.
    //
    // `password` is here deliberately: this is the one route that must compare
    // it. Every other read of `User` selects around it, which is what allows the
    // runtime's table-level SELECT to be narrowed to columns later without
    // breaking authentication. Listing the columns explicitly also means adding
    // a field to the model no longer silently widens what login reads.

    // Signup stores the folded address, so that is what we look for first.
    // Accounts created before folding existed may still hold a mixed-case
    // address, and those owners must not be locked out of their own business —
    // so a miss falls back to the address exactly as typed. The fallback only
    // runs when folding actually changed something, and it is a lookup on the
    // same unique index, never a scan.
    const normalizedEmail = normalizeEmail(email);

    let user = await authDb().user.findUnique({
      where: { email: normalizedEmail },
      select: LOGIN_USER_SELECT,
    });

    if (!user && email !== normalizedEmail) {
      user = await authDb().user.findUnique({
        where: { email },
        select: LOGIN_USER_SELECT,
      });
    }

    if (!user) {
      await recordLoginFailure({ reason: "invalid_credentials" });
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      await recordLoginFailure({
        businessId: user.businessId,
        reason: "invalid_credentials",
      });
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const sessionId = randomUUID();
    const now = new Date();

    // THE SESSION IS CREATED FIRST, AND ITS FAILURE FAILS THE LOGIN.
    //
    // Phase 2 issued the session after the response and swallowed a failure, so a
    // login still succeeded with an ordinary 24-hour token. That is no longer
    // acceptable: the access token now NAMES its session, and per-device
    // revocation is only immediate because every token carries one. A token
    // minted without a session would be a token no device revocation can reach,
    // and it would live for 24 hours. So there is exactly one contract here —
    // a session, or no login.
    //
    // First, before the login stamp, so a failure costs the user nothing at all.
    let session: Awaited<ReturnType<typeof issueRefreshSession>>;
    try {
      session = await issueRefreshSession(authDb(), {
        userId: user.id,
        tokenVersion: user.tokenVersion,
        now,
        // Read here and nowhere else, truncated before the insert, and never
        // returned to a client. No IP, no location, no fingerprint.
        userAgent: req.headers.get("user-agent"),
      });
    } catch (error) {
      console.error(
        "LOGIN_SESSION_ISSUE_ERROR:",
        error instanceof Error ? error.name : "UnknownError"
      );
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }

    // `select` is not cosmetic. Without it Prisma appends RETURNING over every
    // scalar column of the model, and RETURNING needs SELECT on what it returns
    // — including `createdAt`, `updatedAt` and `lastLoginAt`, which the auth
    // plane deliberately cannot read. That is a 42501 on a CORRECT password:
    // the write is permitted, the implicit read back is not. Nothing consumes
    // the result, so it returns the one column this identity may already read.
    await authDb().user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: now,
        loginCount: { increment: 1 },
      },
      select: { id: true },
    });

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGIN,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    await recordSecurityEvent({ type: "AUTH_LOGIN_SUCCESS", outcome: "SUCCESS", businessId: user.businessId, userId: user.id, req });
    const res = NextResponse.json({
      success: true,
      // Minted at the user's CURRENT generation, and NAMING the session above.
      // The generation is the global switch; the session id is what makes a
      // single device revocable on its own.
      token: signAuthToken(user.id, user.tokenVersion, session.sessionId),
      sessionId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        businessId: user.businessId,
        businessName: user.business.name,
      },
    });

    // The credential that outlives the 24-hour token, and never reaches
    // JavaScript.
    setRefreshCookie(res, session.credential, {
      now,
      absoluteExpiresAt: session.absoluteExpiresAt,
    });

    return res;
  } catch (error) {
    if (error instanceof AuthTokenConfigError) {
      console.error("LOGIN_ERROR:", error.message);
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

    console.error("LOGIN_ERROR:", error);

    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
