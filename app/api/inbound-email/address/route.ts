import { NextResponse } from "next/server";

import { handleError } from "@/lib/handle-error";
import {
  guardInboundManagement,
  INBOUND_MANAGEMENT_LIMITS,
} from "@/lib/services/inbound-email/inbound-email-management-guard";
import {
  initializeInboundAddress,
  revokeRetiringAddress,
  rotateInboundAddress,
} from "@/lib/services/inbound-email/inbound-email-management.service";

/**
 * Address lifecycle: create the first one, rotate it, or stop a retiring one.
 *
 * All three are explicit POSTs. None of them is reachable by reading a page, and
 * none of them accepts a business identity from the caller — the tenant comes
 * from the session, and the service scopes every write to it again. An `id` in
 * the body is only ever used inside a query that is already tenant-scoped, so an
 * id belonging to another business matches no row rather than somebody else's.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      addressId?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "initialize") {
      const guard = await guardInboundManagement(req, INBOUND_MANAGEMENT_LIMITS.initialize);
      if (!guard.ok) return guard.response;

      const result = await initializeInboundAddress(guard.actor.businessId, guard.actor.userId);
      if (!result.ok) {
        return NextResponse.json(
          { error: "שירות קבלת המסמכים במייל עדיין לא הוגדר." },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true, created: result.created });
    }

    if (action === "rotate") {
      const guard = await guardInboundManagement(req, INBOUND_MANAGEMENT_LIMITS.rotate);
      if (!guard.ok) return guard.response;

      const result = await rotateInboundAddress(guard.actor.businessId, guard.actor.userId);
      if (!result.ok) {
        const message =
          result.reason === "NO_CURRENT_ADDRESS"
            ? "אין כתובת פעילה להחלפה."
            : "שירות קבלת המסמכים במייל עדיין לא הוגדר.";
        return NextResponse.json({ error: message }, { status: 409 });
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "revoke") {
      const guard = await guardInboundManagement(req, INBOUND_MANAGEMENT_LIMITS.revokeAddress);
      if (!guard.ok) return guard.response;

      const addressId = Number(body.addressId);
      if (!Number.isInteger(addressId) || addressId <= 0) {
        return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 });
      }
      const result = await revokeRetiringAddress(
        guard.actor.businessId,
        addressId,
        guard.actor.userId
      );
      if (!result.ok) {
        // Not found and not-yours are the same answer on purpose: a caller must
        // not learn that an id exists in another tenant.
        return NextResponse.json({ error: "הכתובת לא נמצאה." }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "בקשה לא תקינה." }, { status: 400 });
  } catch (error) {
    return handleError(error);
  }
}
