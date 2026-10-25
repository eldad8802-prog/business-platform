import { updateStaff } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ staffId: string }> };

/** PATCH — rename, recolour, reorder, or deactivate (never delete) a staff member. */
export async function PATCH(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).staffId);
    return json({ staffMember: await updateStaff(principal, id, await jsonBody(req)) });
  });
}
