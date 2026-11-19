import { idempotencyKeyOf, json, jsonBody, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getSettings, updateSettings } from "@/lib/services/service-desk/service-case.service";

/** GET — the business's service settings. */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getSettings(principal.businessId)));
}

/**
 * PUT { expectedVersion: number | null, defaultStaffMemberId, warrantyTemplate } + Idempotency-Key — replace them. Journaled
 * (P4) in ServiceSettingsEvent in the same transaction. Without the P4 journal the service answers NOT_AVAILABLE_UNTIL_AUDIT.
 */
export async function PUT(req: Request) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await updateSettings(principal, { expectedVersion: b.expectedVersion === undefined ? null : b.expectedVersion, defaultStaffMemberId: b.defaultStaffMemberId, warrantyTemplate: b.warrantyTemplate }, { idempotencyKey: key }));
  });
}
