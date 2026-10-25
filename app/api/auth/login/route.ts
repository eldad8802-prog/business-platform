export const dynamic = "force-dynamic";

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { authDb } from "@/lib/prisma-auth";
import { AuthTokenConfigError, signAuthToken } from "@/lib/auth";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import { authMessage, loginLockedMessage } from "@/lib/auth/auth-messages";
import { getServerI18n } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { LOGIN_FAILURE_POLICY, loginAccountRateKey } from "@/lib/auth/account-rate-key";
import { readLoginDevice, setLoginDevice } from "@/lib/auth/login-device";
import bcrypt from "bcrypt";
import { consumeRateLimit, getClientIp, reserveAttempt } from "@/lib/security/rate-limit";
import { safeErrorSummary } from "@/lib/security/log-safe-error";
import { issueRefreshSession } from "@/lib/auth/refresh-session";
import { setRefreshCookie } from "@/lib/auth/refresh-cookie";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";

async function recordLoginFailure(input: {
  businessId?: number | null;
  userId?: number | null;
  reason: string;
}) {
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
/**
 * A bcrypt hash at the cost signup uses (10) of a fixed string that is not, and
 * never was, anyone's password. Compared against when no account matches, so a
 * miss costs the same time as a hit.
 */
const TIMING_EQUALISER_HASH =
  "$2b$10$zN1gFgiX48MtiTQ9xbwAjOBLnk7QFfVFoISIbd2r/jR2k.4gSTfmq";

const LOGIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  password: true,
  businessId: true,
  tokenVersion: true,
  business: { select: { name: true } },
} as const;

/**
 * The temporary lock, answered the same for every address: 429, the Hebrew message with the time
 * left, and Retry-After. Nothing in it is about an account.
 */
function buildLockedResponse(retryAfterMs: number, t: Translator): NextResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    { error: loginLockedMessage(retryAfterMs, t), code: "LOGIN_LOCKED", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const { t } = await getServerI18n();
  const lockedResponse = (retryAfterMs: number) => buildLockedResponse(retryAfterMs, t);
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
        { error: authMessage("rateLimited", t), code: "RATE_LIMITED" },
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
        { error: authMessage("missingCredentials", t), code: "MISSING_CREDENTIALS" },
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

    // The per-IP limit above stops one source; this one stops many sources aimed
    // at ONE address (LOGIN_FAILURE_POLICY: 4 failures in a rolling 15 minutes →
    // a 15-minute lock; a warning at the third). The attempt is RESERVED here,
    // atomically and before any password is compared — so a parallel burst runs at
    // most four comparisons, and a locked address compares nothing — and the
    // ledger is cleared below if the password is right: a success is never a failure.
    // Keyed on a digest of the folded address, for every address alike, so no
    // answer here says whether an account exists. A browser that already signed in
    // to this address counts on its own ledger, out of a stranger's reach.
    const deviceNonce = readLoginDevice(req, normalizedEmail);
    const attempt = await reserveAttempt({
      key: loginAccountRateKey(normalizedEmail, deviceNonce),
      limit: LOGIN_FAILURE_POLICY.limit,
      windowMs: LOGIN_FAILURE_POLICY.windowMs,
    });
    if (!attempt.allowed) {
      await recordLoginFailure({ reason: "locked_account" });
      return lockedResponse(attempt.retryAfterMs);
    }

    // A wrong password (or no such account — answered identically): counted; the
    // third failure warns, the fourth locks.
    const failedSignIn = async (businessId: number | null) => {
      await recordLoginFailure({ businessId, reason: "invalid_credentials" });
      if (attempt.count >= LOGIN_FAILURE_POLICY.limit) {
        await attempt.lock(LOGIN_FAILURE_POLICY.lockMs);
        return lockedResponse(LOGIN_FAILURE_POLICY.lockMs);
      }
      const warn = attempt.count === LOGIN_FAILURE_POLICY.warnAtFailure;
      return NextResponse.json(
        {
          error: authMessage("invalidCredentials", t),
          code: "INVALID_CREDENTIALS",
          ...(warn ? { warning: authMessage("loginLastAttemptWarning", t), attemptsLeft: 1 } : {}),
        },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    };

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
      // Spend the same bcrypt work a real account costs. Returning at once made
      // an unknown address measurably faster than a wrong password, which told
      // anyone timing the endpoint which addresses have an account.
      await bcrypt.compare(password, TIMING_EQUALISER_HASH);
      return failedSignIn(null);
    }

    // An account opened with Google has no password (User.password is NULL) until its owner sets one
    // through the reset link. Typing a password for it is answered exactly like a wrong password: the
    // same bcrypt work (against the equaliser, which matches nothing), the same counted failure, the
    // same 401 — so the answer says nothing about how the account was opened.
    const isPasswordValid =
      (await bcrypt.compare(password, user.password ?? TIMING_EQUALISER_HASH)) && user.password !== null;

    if (!isPasswordValid) {
      return failedSignIn(user.businessId);
    }

    // The right password: not a failure — and the failures before it on this ledger
    // are cleared (whoever typed them now proved the password). Before anything else
    // can fail, so a server error after this point never counts against the owner.
    await attempt.clear();

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
      return NextResponse.json({ error: authMessage("serverError", t), code: "SERVER_ERROR" }, { status: 500 });
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

    // This browser has now signed in to this address: from here on its failures
    // count on its own ledger (lib/auth/login-device.ts). Not a credential.
    setLoginDevice(res, normalizedEmail, deviceNonce);

    return res;
  } catch (error) {
    if (error instanceof AuthTokenConfigError) {
      console.error("LOGIN_ERROR:", error.message);
      return NextResponse.json(
        {
          error:
            process.env.NODE_ENV === "production"
              ? authMessage("serviceUnavailable", t)
              : error.message,
        },
        { status: 503 }
      );
    }

    console.error("LOGIN_ERROR:", safeErrorSummary(error));

    return NextResponse.json({ error: authMessage("serverError", t), code: "SERVER_ERROR" }, { status: 500 });
  }
}
