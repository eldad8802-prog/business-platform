export const dynamic = "force-dynamic";

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthTokenConfigError, signAuthToken } from "@/lib/auth";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import bcrypt from "bcrypt";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
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
    // step and threw, which surfaced as a 500 on what is really a bad request.
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      await recordLoginFailure({ reason: "missing_credentials" });
      return NextResponse.json(
        { error: "Missing email or password" },
        { status: 400 }
      );
    }

    // Signup stores the folded address, so that is what we look for first.
    // Accounts created before folding existed may still hold a mixed-case
    // address, and those owners must not be locked out of their own business —
    // so a miss falls back to the address exactly as typed. The fallback only
    // runs when folding actually changed something, and it is a lookup on the
    // same unique index, never a scan.
    const normalizedEmail = normalizeEmail(email);

    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { business: true },
    });

    if (!user && email !== normalizedEmail) {
      user = await prisma.user.findUnique({
        where: { email },
        include: { business: true },
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

    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: now,
        loginCount: { increment: 1 },
      },
    });

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      sessionId,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGIN,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    return NextResponse.json({
      success: true,
      // Minted at the user's CURRENT generation. A token signed at generation 0
      // for someone who has logged out three times would be refused on its very
      // first request.
      token: signAuthToken(user.id, user.tokenVersion),
      sessionId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        businessId: user.businessId,
        businessName: user.business.name,
      },
    });
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
