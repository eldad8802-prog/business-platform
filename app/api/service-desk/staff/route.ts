import { json, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { listActiveStaff } from "@/lib/services/service-desk/service-case.service";

/** GET — the business's active staff members (id + display name), for the technician pickers. */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await listActiveStaff(principal.businessId)));
}
