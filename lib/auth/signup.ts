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
 * SCOPE BOUNDARY: this module creates the account and nothing else. It does not
 * decide whether registration is OPEN — that is the public-signup gate, checked
 * first in the route — and it does not mint sessions, send mail or raise events.
 * Those are separate concerns with separate failure modes.
 *
 * The rules about what an identity IS live in ./signup-identity.ts, which has no
 * dependencies and is therefore testable without a database.
 */

import { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";

import { prisma } from "@/lib/prisma";

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
    return await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: { name: input.businessName },
      });

      const user = await tx.user.create({
        data: {
          email: input.email,
          password: input.passwordHash,
          name: input.name,
          businessId: business.id,
        },
      });

      return {
        userId: user.id,
        businessId: business.id,
        email: user.email,
        name: input.name,
        businessName: business.name,
        tokenVersion: user.tokenVersion,
      };
    });
  } catch (error) {
    // P2002 = unique constraint violation. The only unique constraint reachable
    // from this transaction is User.email, so this is a duplicate signup — the
    // Business insert is rolled back with it, leaving nothing orphaned.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new EmailAlreadyRegisteredError();
    }
    throw error;
  }
}
