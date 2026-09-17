import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isInboundEmailEnabled } from "@/lib/inbound-email/inbound-email-flag";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

/**
 * The gate every inbound-email management endpoint goes through.
 *
 * # Why the flag is checked on the server and not only in the navigation
 *
 * Hiding a menu item hides the feature from somebody who was not looking for it.
 * It does nothing about a request sent directly to the endpoint, and an
 * unfinished management surface reachable by URL is reachable in Production the
 * moment this merges. So the flag is the FIRST thing checked, before
 * authentication, before rate limiting, before any read: while it is off these
 * routes do not exist as far as a caller can tell.
 *
 * # Order, and why it is this order
 *
 * Flag, then authentication, then rate limit. Checking the flag first means a
 * disabled feature cannot be probed for whether a session is valid. Rate
 * limiting after authentication means the limit can be keyed to the tenant
 * rather than only to an address anyone can change.
 */

export type ManagementActor = { userId: number; businessId: number; email: string | null };

export type GuardResult =
  | { ok: true; actor: ManagementActor }
  | { ok: false; response: NextResponse };

/** Indistinguishable from a route that was never deployed. */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function guardInboundManagement(
  req: Request,
  limit?: { action: string; max: number; windowMs: number }
): Promise<GuardResult> {
  if (!isInboundEmailEnabled()) return { ok: false, response: notFound() };

  const user = await getCurrentUser(req);
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const businessId = (user as { businessId?: number }).businessId;
  if (!Number.isInteger(businessId) || (businessId as number) <= 0) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (limit) {
    // Keyed on the TENANT, not on the caller's address. A management limit that
    // an attacker resets by changing IP protects nothing, and these are actions
    // a business performs a handful of times, not per request.
    const rl = await consumeRateLimit({
      key: `inbound-email:${limit.action}:${businessId}:${getClientIp(req)}`,
      limit: limit.max,
      windowMs: limit.windowMs,
    });
    if (!rl.allowed) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "יותר מדי בקשות. נסי שוב בעוד רגע." },
          { status: 429 }
        ),
      };
    }
  }

  return {
    ok: true,
    actor: {
      userId: (user as { id: number }).id,
      businessId: businessId as number,
      email: (user as { email?: string | null }).email ?? null,
    },
  };
}

/**
 * Management limits.
 *
 * Deliberately small. Creating or rotating a forwarding address is something a
 * business does once and then rarely; a caller doing it dozens of times a minute
 * is not using the product. Adding and revoking senders is more frequent but
 * still human-paced. The windows follow the repository's existing minute-based
 * convention rather than inventing a new unit.
 */
export const INBOUND_MANAGEMENT_LIMITS = {
  /** One address per business, so repeated attempts are retries, not work. */
  initialize: { action: "address-init", max: 5, windowMs: 60_000 },
  /** Each rotation retires an address for thirty days; churning is not normal. */
  rotate: { action: "address-rotate", max: 3, windowMs: 60_000 },
  revokeAddress: { action: "address-revoke", max: 10, windowMs: 60_000 },
  addSender: { action: "sender-add", max: 10, windowMs: 60_000 },
  revokeSender: { action: "sender-revoke", max: 10, windowMs: 60_000 },
} as const;
