/**
 * The one place a user's password HASH is replaced.
 *
 * On the RUNTIME plane, deliberately. The auth plane's grants say "the auth
 * plane may verify a credential and may not change one" (migration
 * 20260908180000: app_auth holds SELECT on "password" and no UPDATE on it),
 * while app_runtime holds UPDATE ("password", "updatedAt") on "User". So the
 * generation move (auth plane) and the hash write (runtime plane) are two
 * statements on two identities — and the ORDER is the security property:
 *
 *   1. the generation moves first (conditional, single winner) — every token
 *      and session of the old generation is dead from this instant;
 *   2. then the hash is written.
 *
 * If step 2 fails the user has been signed out everywhere and the OLD password
 * still works: a fail-closed outcome (sign in again, retry). The reverse order
 * could leave a new password in place with an attacker's sessions still alive.
 *
 * No schema change and no new grant is needed for this.
 */

import bcrypt from "bcrypt";

import { prisma } from "@/lib/prisma";
import { BCRYPT_ROUNDS } from "./signup";

export function hashNewPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export class PasswordWriteError extends Error {
  constructor() {
    super("password_write_failed");
    this.name = "PasswordWriteError";
  }
}

/**
 * `updateMany` rather than `update`: it compiles to one UPDATE with no
 * RETURNING, so the runtime plane needs no SELECT beyond `id` (which it holds).
 */
export async function writePasswordHash(userId: number, passwordHash: string): Promise<void> {
  const { count } = await prisma.user.updateMany({
    where: { id: userId },
    data: { password: passwordHash },
  });
  if (count !== 1) throw new PasswordWriteError();
}
