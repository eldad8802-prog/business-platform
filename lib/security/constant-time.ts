import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for secrets of any length (L-11).
 *
 * Both sides are hashed to a fixed 32 bytes first, so neither the content nor
 * the LENGTH of the expected secret leaks through timing (a plain `!==` or a
 * length-checked timingSafeEqual leaks the length).
 */
export function secretsEqual(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
