import { json, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { ServiceDeskError } from "@/lib/services/service-desk/service-desk-errors";
import { getSettings } from "@/lib/services/service-desk/service-case.service";

/** GET — the business's service settings. */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getSettings(principal.businessId)));
}

/**
 * PUT { expectedVersion, defaultStaffMemberId, warrantyTemplate } — replace the settings — CLOSED until the P4 audit journal exists (owner decision 2026-11-09, option B): this write would leave no
 * audit event. The edge still authenticates and applies the access gate first (401 / 404 / 403 READ_ONLY); then the
 * request is refused before its body is read or anything is written. No fake success.
 */
export async function PUT(req: Request) {
  return serviceDeskRoute(req, "write", async () => {
    throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_AUDIT");
  });
}
