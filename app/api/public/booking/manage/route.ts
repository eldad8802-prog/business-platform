import { cancelByToken, viewByToken } from "@/lib/services/booking/public-booking.service";
import { jsonBodyOf, publicJson, publicRoute } from "@/lib/services/booking/public-http";
import { AppointmentServiceError } from "@/lib/services/appointment/appointment-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { token, action: "view" | "cancel" } — the customer's own link (D9, D12). The token travels in the body, never
 * in a URL the server logs (the page keeps it in the URL fragment). No session.
 */
export async function POST(req: Request) {
  return publicRoute(req, "PUBLIC_BOOKING_MANAGE", async () => {
    const body = await jsonBodyOf(req);
    if (body.action === "view") return publicJson(await viewByToken(body.token));
    if (body.action === "cancel") return publicJson(await cancelByToken(body.token));
    throw new AppointmentServiceError("INVALID_INPUT", { field: "action" });
  });
}
