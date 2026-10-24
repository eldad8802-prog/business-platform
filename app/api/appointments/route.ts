import { createAppointment, listAppointments } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, idempotencyKeyOf, json, jsonBody, numericParam, queryOf } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

/** GET — the calendar of a range: appointments starting in [from, to) (≤ 62 days), optionally one staff lane. */
export async function GET(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const q = queryOf(req);
    const appointments = await listAppointments(principal, {
      from: q.from,
      to: q.to,
      staffMemberId: q.staffMemberId === "none" ? null : numericParam(q.staffMemberId),
      includeCanceled: q.includeCanceled,
    });
    return json({ appointments });
  });
}

/** POST — the owner books a customer appointment, an internal meeting or a time block. Idempotency-Key required. */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const key = idempotencyKeyOf(req);
    const result = await createAppointment(principal, { idempotencyKey: key }, await jsonBody(req));
    return json(result, result.replayed ? 200 : 201);
  });
}
