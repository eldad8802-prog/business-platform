export const dynamic = "force-dynamic";

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { authDb } from "@/lib/prisma-auth";
import { AuthTokenConfigError, signAuthToken } from "@/lib/auth";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import { getClientIp } from "@/lib/security/rate-limit";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import {
  authThrottleResponse,
  bcryptCompare,
  verifyPassword,
  type PasswordComparer,
} from "@/lib/auth/credential-check";
import { acceptsNormalWrites } from "@/lib/tenant/business-lifecycle";
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
const LOGIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  password: true,
  businessId: true,
  tokenVersion: true,
  // name for the response; the two timestamps for the lifecycle gate (AUTH-12):
  // a business under the deletion quarantine must not be handed a session.
  business: { select: { name: true, deletionRequestedAt: true, deletedAt: true } },
} as const;

export type LoginDeps = {
  /** Injected so a proof can count comparisons; production is bcrypt. */
  compare: PasswordComparer;
};

const defaultLoginDeps: LoginDeps = { compare: bcryptCompare };

/**
 * THROTTLING (M-7). Two fail-CLOSED buckets on the shared limiter:
 *   AUTH_LOGIN_IP       before the body is read — per address;
 *   AUTH_LOGIN_ACCOUNT  once the address is known — per normalized email, and
 *                       per (email, address) pair.
 * Keyed by the normalized address whether or not an account exists, and the
 * throttled response is identical either way, so throttling is not an oracle.
 *
 * TIMING (M-7). Exactly one bcrypt comparison runs for every well-formed
 * attempt — against a dummy hash when the account does not exist — and both
 * address spellings are looked up whenever they differ, so neither latency nor
 * query count depends on whether the account exists.
 */
export async function handleLogin(req: Request, deps: LoginDeps = defaultLoginDeps) {
  try {
    const ip = getClientIp(req);
    const ipGate = await checkRateLimit({ bucket: "AUTH_LOGIN_IP", ip });
    if (!ipGate.allowed) {
      await recordLoginFailure({ reason: "rate_limited" });
      return authThrottleResponse(ipGate);
    }

    const body = await req.json().catch(() => null);
    const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };

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

    const accountGate = await checkRateLimit({
      bucket: "AUTH_LOGIN_ACCOUNT",
      account: normalizedEmail,
      ip,
    });
    if (!accountGate.allowed) {
      await recordLoginFailure({ reason: "rate_limited" });
      return authThrottleResponse(accountGate);
    }

    // Both spellings, in parallel, whenever they differ — never "the second
    // only on a miss", which made the query count reveal whether the folded
    // address has an account. The folded match still wins.
    const [foldedUser, typedUser] = await Promise.all([
      authDb().user.findUnique({
        where: { email: normalizedEmail },
        select: LOGIN_USER_SELECT,
      }),
      email !== normalizedEmail
        ? authDb().user.findUnique({ where: { email }, select: LOGIN_USER_SELECT })
        : Promise.resolve(null),
    ]);
    const user = foldedUser ?? typedUser;

    // ONE comparison whatever happened above: against the real hash, or against
    // a dummy of the same cost when there is no such account.
    const isPasswordValid = await verifyPassword(password, user?.password ?? null, deps.compare);

    if (!user) {
      await recordLoginFailure({ reason: "invalid_credentials" });
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

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

    // AUTH-12: the password was right, but a business being erased gets no
    // session. Checked with the CANONICAL lifecycle gate, the same one
    // getAuthContext and the refresh engine use, and only after the password
    // was proven — so this distinct answer tells nothing to anyone who does not
    // already hold the credential.
    if (!user.business || !acceptsNormalWrites(user.business)) {
      await recordLoginFailure({
        businessId: user.businessId,
        userId: user.id,
        reason: "account_quarantined",
      });
      return NextResponse.json(
        { error: "This account is closed", code: "ACCOUNT_UNAVAILABLE" },
        { status: 403 }
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

    console.error("LOGIN_ERROR:", error instanceof Error ? error.name : "UnknownError");

    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handleLogin(req);
}
