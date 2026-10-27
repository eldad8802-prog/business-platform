import { countPendingRequests, listBookingRequests } from "@/lib/services/booking/booking-admin.service";
import { appointmentsRoute, json } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — pending requests, confirmed ones whose customer is still to be linked, and the last day's decisions. ?count=1: the badge only. */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    if (new URL(req.url).searchParams.get("count") === "1") return json({ pending: await countPendingRequests(principal) });
    return json(await listBookingRequests(principal));
  });
}
