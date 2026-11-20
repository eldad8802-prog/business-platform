import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getCaseCharges, recordCharge } from "@/lib/services/service-desk/case-charge.service";

/** GET — the case's charge history, its billing links (active and history) and the balance computed now. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getCaseCharges(principal.businessId, positiveId((await context.params).id))));
}

/**
 * POST { mode: "CHARGEABLE" | "NO_CHARGE", amountAgorot?, reason?, expectedVersion } + Idempotency-Key — record what the
 * case is charged (a new record of its history; a reason for NO_CHARGE and for every change). Journaled (charge.recorded).
 * Without migration 20261126090000 the service answers NOT_AVAILABLE_UNTIL_MIGRATION and writes nothing.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await recordCharge(principal, id, { mode: b.mode, amountAgorot: b.amountAgorot, reason: b.reason, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
