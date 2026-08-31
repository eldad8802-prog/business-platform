import { NotFoundError } from "@/lib/errors";

/**
 * `Coupon.publicId` is a Postgres `uuid` column, so Prisma refuses to compare it
 * against a string that is not a UUID and the query throws. Both services that
 * look a coupon up by public id checked only that the value was a non-empty
 * string, so any other shape — a numeric id, a truncated share link, a typo —
 * reached the database and surfaced as a 500. On the public detail route that is
 * an anonymously reachable 500; on the code route it sits in front of the
 * redemption secret.
 *
 * A malformed id is answered exactly as a missing one. That is deliberate:
 * `assertCouponCodeAccess` already refuses to let a caller distinguish coupon
 * states (a foreign coupon and an expired one both read as 403), and a distinct
 * status for "wrong shape" would hand back a probing signal for free. It is also
 * the truthful answer for a broken share link — there is no such coupon.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the id when it is a well-formed UUID; otherwise throws 404. */
export function assertCouponPublicId(raw: unknown): string {
  if (typeof raw !== "string" || !UUID.test(raw)) {
    throw new NotFoundError("Coupon not found");
  }
  return raw;
}
