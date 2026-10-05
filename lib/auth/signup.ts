/**
 * Signup — account creation, as one indivisible act.
 *
 * WHY THIS EXISTS: creating an account used to be two unrelated writes. A
 * `Business` row was created, and then a `User` row was created against it. If
 * the second write failed — a duplicate email losing a race, a dropped
 * connection, a timeout — the first one stayed. The result was a tenant with no
 * one able to log into it: invisible, unreachable, and permanent. Nothing
 * cleaned it up because nothing knew it was wrong.
 *
 * A business and its first owner are not two facts. They are one fact with two
 * rows, so they are written in one transaction or not at all.
 *
 * The account's first SESSION belongs to the same fact. Signup used to mint a
 * bare token with no session row behind it: no refresh, no device entry, no way
 * to revoke that one device, and a hard sign-out after 24 hours. A new owner was
 * a second, weaker kind of authenticated user. The session row is now written in
 * the same transaction, through the same `issueRefreshSession` login uses, so
 * signup ends exactly where login ends — or nothing is written at all.
 *
 * SCOPE BOUNDARY: this module creates the account and its first session, and
 * nothing else. It does not decide whether registration is OPEN — that is the
 * public-signup gate, checked first in the route — and it does not mint tokens,
 * set cookies, send mail or raise events.
 *
 * The rules about what an identity IS live in ./signup-identity.ts, which has no
 * dependencies and is therefore testable without a database.
 */

import { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";

import { authDb } from "@/lib/prisma-auth";
import { issueRefreshSession } from "@/lib/auth/refresh-session";

import {
  EmailAlreadyRegisteredError,
  type NormalizedSignup,
} from "./signup-identity";

export {
  EmailAlreadyRegisteredError,
  MIN_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  SignupValidationError,
  normalizeEmail,
  normalizeSignupInput,
} from "./signup-identity";
export type {
  NormalizedSignup,
  SignupField,
  SignupInput,
} from "./signup-identity";

/** Cost factor for password hashing. Matches what login already verifies against. */
export const BCRYPT_ROUNDS = 10;

export type CreateAccountInput = {
  email: string;
  /** Already hashed. Hashing is a separate, injectable step so it stays observable in tests. */
  passwordHash: string;
  name: string;
  businessName: string;
  /** The one instant every session timestamp is derived from (see issueRefreshSession). */
  now: Date;
  /** Device label source. Truncated downstream, never returned to a client. */
  userAgent?: string | null;
};

export type CreatedAccount = {
  userId: number;
  businessId: number;
  email: string;
  name: string;
  businessName: string;
  /**
   * The generation the account starts at. Read from the row rather than assumed
   * to be 0, so the caller mints a token that matches what was actually written.
   */
  tokenVersion: number;
  /** The first session — the same row, credential and expiry login issues. */
  session: { sessionId: string; credential: string; absoluteExpiresAt: Date };
};

export function hashSignupPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Create the business and its first owner atomically.
 *
 * There is no pre-flight "does this email exist" query, and that is deliberate.
 * A check followed by a write is not a guarantee — two requests can both pass
 * the check before either writes, and the loser used to surface as a raw 500.
 * The unique index is the only authority that cannot be raced, so we write and
 * let it decide, translating its rejection into a specific, honest error.
 */
export async function createAccount(
  input: CreateAccountInput
): Promise<CreatedAccount> {
  try {
    return await authDb().$transaction(async (tx) => {
      // Both creates name their columns for the same reason the login stamp
      // does: without `select`, Prisma appends RETURNING over every scalar
      // column, and the auth plane holds SELECT on a deliberate subset. The
      // lists below are exactly the fields this function goes on to read.
      const business = await tx.business.create({
        data: { name: input.businessName },
        select: { id: true, name: true },
      });

      const user = await tx.user.create({
        data: {
          email: input.email,
          password: input.passwordHash,
          name: input.name,
          businessId: business.id,
        },
        select: { id: true, email: true, tokenVersion: true },
      });

      // Last, so a failure here rolls back the account with it: the visitor
      // gets an error and can simply try again, instead of an account they can
      // only reach by guessing that they should go and log in.
      const session = await issueRefreshSession(tx, {
        userId: user.id,
        tokenVersion: user.tokenVersion,
        now: input.now,
        userAgent: input.userAgent ?? null,
      });

      return {
        userId: user.id,
        businessId: business.id,
        email: user.email,
        name: input.name,
        businessName: business.name,
        tokenVersion: user.tokenVersion,
        session,
      };
    });
  } catch (error) {
    // P2002 = unique constraint violation. The only unique constraint a caller
    // can collide with in this transaction is User.email (the session id is a
    // generated uuid), so this is a duplicate signup — the Business insert is
    // rolled back with it, leaving nothing orphaned.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new EmailAlreadyRegisteredError();
    }
    throw error;
  }
}
