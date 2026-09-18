import { NextResponse } from "next/server";

import { handleError } from "@/lib/handle-error";
import {
  INBOUND_MANAGEMENT_LIMITS,
  guardInboundManagement,
  inboundManagementDisabled,
} from "@/lib/services/inbound-email/inbound-email-management-guard";
import {
  addAuthorizedSender,
  revokeAuthorizedSender,
} from "@/lib/services/inbound-email/inbound-email-management.service";

/**
 * Authorized senders: add one, or withdraw one.
 *
 * The caller supplies an email and nothing else. It cannot supply a status, a
 * business, a key or a verification timestamp — a new sender is always
 * PENDING_VERIFICATION, and no path through this file can produce any other
 * state. Verification itself is a later increment, so "pending" here means
 * exactly what it says and is not a button waiting to be wired.
 */
export async function POST(req: Request) {
  // Before the body is read, before the session, before the limiter: while the
  // feature is off every shape of request gets the same answer.
  const off = inboundManagementDisabled();
  if (off) return off;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      email?: unknown;
      senderId?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "add") {
      const guard = await guardInboundManagement(req, INBOUND_MANAGEMENT_LIMITS.addSender);
      if (!guard.ok) return guard.response;

      if (typeof body.email !== "string") {
        return NextResponse.json({ error: "יש להזין כתובת מייל." }, { status: 400 });
      }
      const result = await addAuthorizedSender(
        guard.actor.businessId,
        body.email,
        guard.actor.userId
      );
      if (!result.ok) {
        return NextResponse.json({ error: "כתובת המייל אינה תקינה." }, { status: 400 });
      }
      // `created: false` means one already existed. Answering the same way
      // either time keeps a double submit from reading as a failure.
      return NextResponse.json({ ok: true, status: result.status, created: result.created });
    }

    if (action === "revoke") {
      const guard = await guardInboundManagement(req, INBOUND_MANAGEMENT_LIMITS.revokeSender);
      if (!guard.ok) return guard.response;

      const senderId = Number(body.senderId);
      if (!Number.isInteger(senderId) || senderId <= 0) {
        return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 });
      }
      const result = await revokeAuthorizedSender(
        guard.actor.businessId,
        senderId,
        guard.actor.userId
      );
      if (!result.ok) {
        return NextResponse.json({ error: "השולח לא נמצא." }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 });
  } catch (error) {
    return handleError(error);
  }
}
