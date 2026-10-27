import { decideBookingRequest, linkBookingCustomer } from "@/lib/services/booking/booking-admin.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";
import { invalid } from "@/lib/services/appointment/appointment-errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * POST { action: "approve" | "decline", expectedVersion }   — Idempotency-Key required; the calendar's own status change.
 * POST { action: "link", customerId | create: true, expectedVersion } — D6: the owner links the customer card.
 */
export async function POST(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).id);
    const body = await jsonBody(req);
    if (body.action === "approve" || body.action === "decline") {
      return json(await decideBookingRequest(principal, { idempotencyKey: idempotencyKeyOf(req) }, id, { decision: body.action, expectedVersion: body.expectedVersion }));
    }
    if (body.action === "link") return json(await linkBookingCustomer(principal, id, body));
    throw invalid("action");
  });
}
