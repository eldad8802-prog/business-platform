import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcrypt";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";
import {
  SIGNUP_DISABLED_STATUS,
  isPublicSignupEnabled,
  signupDisabledBody,
} from "@/lib/auth/signup-gate";

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
 */
export type RegisterDeps = {
  isSignupEnabled: () => boolean;
  rateLimit: typeof consumeRateLimit;
  findUserByEmail: (email: string) => Promise<{ id: number } | null>;
  createBusiness: (input: { name: string }) => Promise<{ id: number }>;
  createUser: (input: {
    email: string;
    password: string;
    name: string;
    businessId: number;
  }) => Promise<{ id: number }>;
  hashPassword: (plain: string) => Promise<string>;
};

const defaultDeps: RegisterDeps = {
  isSignupEnabled: isPublicSignupEnabled,
  rateLimit: consumeRateLimit,
  findUserByEmail: (email) =>
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
  createBusiness: ({ name }) =>
    prisma.business.create({ data: { name }, select: { id: true } }),
  createUser: (data) => prisma.user.create({ data, select: { id: true } }),
  hashPassword: (plain) => bcrypt.hash(plain, 10),
};

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
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const body = await req.json();
    const { email, password, name, businessName } = body;

    if (!email || !password || !name || !businessName) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const existingUser = await deps.findUserByEmail(email);

    if (existingUser) {
      return NextResponse.json(
        { error: "User already exists" },
        { status: 400 }
      );
    }

    const hashedPassword = await deps.hashPassword(password);

    const business = await deps.createBusiness({ name: businessName });

    const user = await deps.createUser({
      email,
      password: hashedPassword,
      name,
      businessId: business.id,
    });

    return NextResponse.json({
      success: true,
      userId: user.id,
      businessId: business.id,
    });
  } catch (error) {
    console.error("REGISTER_ERROR:", error);

    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  return handleRegister(req);
}
