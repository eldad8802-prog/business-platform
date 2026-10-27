import { setStaffServices } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json, jsonBody, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ staffId: string }> };

/** PUT — the whole list of services this staff member performs (what is not listed is removed). */
export async function PUT(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const id = positiveId((await params).staffId);
    return json(await setStaffServices(principal, id, await jsonBody(req)));
  });
}
