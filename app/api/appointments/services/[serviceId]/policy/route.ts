import { getServicePolicy, upsertServicePolicy } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ serviceId: string }> };

/** GET — the booking policy of one catalog service (the defaults when none was saved). */
export async function GET(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) =>
    json({ policy: await getServicePolicy(principal, positiveId((await params).serviceId)) }));
}

/** PUT — save the booking policy (buffers, notice, horizon, slot step, approval mode, windows). No payment fields. */
export async function PUT(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) =>
    json({ policy: await upsertServicePolicy(principal, positiveId((await params).serviceId), await jsonBody(req)) }));
}
