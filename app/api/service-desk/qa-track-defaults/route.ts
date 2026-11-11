import { json, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getQaTrackDefaults } from "@/lib/services/service-desk/qa-track-defaults.service";

/**
 * GET — the business's own default QA list per service track (T1–T7): the list and its state, the revision to send back,
 * the track's QA mode in the current profile and whether a case opened now would take it. `available: false` before
 * migrations 20261129090000 + 20261130100000.
 */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getQaTrackDefaults(principal.businessId)));
}
