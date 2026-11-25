import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { searchAppointments } from "@/lib/services/appointment/appointment-daily-use.service";
import { appointmentsRoute, json, queryOf } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/**
 * GET ?q= — the owner's appointment search (G8): a customer's name or phone digits (at least 2 characters), upcoming
 * first then recent past, at most 30. Scoped to the session's business; rate-limited per user and business.
 */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const decision = await checkRateLimit({ bucket: "APPOINTMENTS_SEARCH", user: principal.userId, business: principal.businessId });
    if (!decision.allowed) return buildRateLimitResponse(decision);
    return json({ results: await searchAppointments(principal, { q: queryOf(req).q }) });
  });
}
