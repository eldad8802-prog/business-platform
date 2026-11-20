import { idempotencyKeyOf, json, jsonBody, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getProfileChoice, saveProfileChoice } from "@/lib/services/service-desk/case-extras.service";

/** GET — the activation choice: the stored profile, else the one the business category suggests (decision 1). */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getProfileChoice(principal.businessId)));
}

/** PUT { expectedVersion, serviceProfileKey, offeredTracks } + Idempotency-Key — journaled in ServiceSettingsEvent. */
export async function PUT(req: Request) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await saveProfileChoice(principal, { expectedVersion: b.expectedVersion, serviceProfileKey: b.serviceProfileKey, offeredTracks: b.offeredTracks }, { idempotencyKey: key }));
  });
}
