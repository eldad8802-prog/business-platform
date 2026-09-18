import { NextResponse } from "next/server";

import { handleError } from "@/lib/handle-error";
import {
  guardInboundManagement,
  inboundManagementDisabled,
} from "@/lib/services/inbound-email/inbound-email-management-guard";
import { getInboundEmailSettings } from "@/lib/services/inbound-email/inbound-email-management.service";

/**
 * The settings surface for inbound-email forwarding.
 *
 * READ ONLY, and that is a design decision rather than an accident. This
 * endpoint creates nothing: no address is minted because somebody opened the
 * page, and no row appears because a tab was left refreshing overnight. A
 * business gets a forwarding address when it asks for one, which makes "we have
 * an address" mean somebody decided to have one.
 */
export async function GET(req: Request) {
  // Before the body is read, before the session, before the limiter: while the
  // feature is off every shape of request gets the same answer.
  const off = inboundManagementDisabled();
  if (off) return off;

  try {
    const guard = await guardInboundManagement(req);
    if (!guard.ok) return guard.response;

    const settings = await getInboundEmailSettings(guard.actor.businessId);

    // The authenticated user's own address, offered to the form as a starting
    // value. It is a SUGGESTION: nothing is stored until the owner adds it, and
    // adding it produces a sender that still has to be verified.
    return NextResponse.json({ ...settings, suggestedSenderEmail: guard.actor.email });
  } catch (error) {
    return handleError(error);
  }
}
