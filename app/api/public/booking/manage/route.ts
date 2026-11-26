import { cancelByToken, rescheduleByToken, rescheduleSlotsByToken, viewByToken } from "@/lib/services/booking/public-booking.service";
import { jsonBodyOf, publicJson, publicRoute } from "@/lib/services/booking/public-http";
import { AppointmentServiceError } from "@/lib/services/appointment/appointment-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { token, action } — the customer's own link (D9, D12, G15). The token travels in the body, never in a URL the
 * server logs (the page keeps it in the URL fragment). No session.
 *   view                          the booking's state;
 *   cancel                        cancel / withdraw within the business's policy;
 *   slots { fromDay, toDay }      free times the confirmed appointment may move to (G15);
 *   reschedule { startsAt }       move it there (G15) — only while the business allows it and its window is open.
 */
export async function POST(req: Request) {
  return publicRoute(req, "PUBLIC_BOOKING_MANAGE", async () => {
    const body = await jsonBodyOf(req);
    if (body.action === "view") return publicJson(await viewByToken(body.token));
    if (body.action === "cancel") return publicJson(await cancelByToken(body.token));
    if (body.action === "slots") return publicJson(await rescheduleSlotsByToken(body.token, { fromDay: body.fromDay, toDay: body.toDay }));
    if (body.action === "reschedule") return publicJson(await rescheduleByToken(body.token, { startsAt: body.startsAt }));
    throw new AppointmentServiceError("INVALID_INPUT", { field: "action" });
  });
}
