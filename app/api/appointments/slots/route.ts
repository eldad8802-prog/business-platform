import { findSlots } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, json, numericParam, queryOf } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — free slots for a service (or a length) over days [fromDay, toDay] (≤ 31), for one staff lane or the business. */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const q = queryOf(req);
    const out = await findSlots(principal, {
      fromDay: q.fromDay,
      toDay: q.toDay,
      businessServiceId: numericParam(q.businessServiceId),
      durationMinutes: numericParam(q.durationMinutes),
      staffMemberId: numericParam(q.staffMemberId),
    });
    return json({
      durationMinutes: out.durationMinutes,
      slots: out.slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })),
    });
  });
}
