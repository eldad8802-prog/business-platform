import { getServicePolicy, upsertServicePolicy } from "@/lib/services/appointment/appointment-config.service";
import { readHoursImpact } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ serviceId: string }> };

/** GET — the booking policy of one catalog service (the defaults when none was saved). */
export async function GET(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) =>
    json({ policy: await getServicePolicy(principal, positiveId((await params).serviceId)) }));
}

/**
 * PUT — save the booking policy (buffers, notice, horizon, slot step, approval mode, windows). No payment fields.
 * The answer also says how many of the service's live future appointments sit outside the hours (G20 — information
 * only; an existing appointment keeps the buffers it was booked with).
 */
export async function PUT(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const serviceId = positiveId((await params).serviceId);
    const policy = await upsertServicePolicy(principal, serviceId, await jsonBody(req));
    return json({ policy, impact: await readHoursImpact(principal, { businessServiceId: serviceId }) });
  });
}
