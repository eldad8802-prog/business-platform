import { countPendingRequests, listBookingRequests } from "@/lib/services/booking/booking-admin.service";
import { publicBookingOpen } from "@/lib/services/booking/public-booking.service";
import { appointmentsRoute, json } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/**
 * GET — pending requests, confirmed ones whose customer is still to be linked, and the last day's decisions.
 * ?count=1: the badge only, and whether public booking is open for the business (the calendar shows its entry points
 * only then, or while a request still waits).
 */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    if (new URL(req.url).searchParams.get("count") === "1") {
      return json({ pending: await countPendingRequests(principal), open: await publicBookingOpen(principal.businessId) });
    }
    return json(await listBookingRequests(principal));
  });
}
