import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { listPickupReminders, recordPickupReminder } from "@/lib/services/service-desk/case-extras.service";

type Ctx = { params: Promise<{ id: string }> };

/** GET — the case's documented pickup calls, newest first (UI 1.3, ו3). */
export async function GET(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await listPickupReminders(principal.businessId, positiveId((await context.params).id))));
}

/** POST { outcome: REACHED | LEFT_MESSAGE | NO_ANSWER, note? } + Idempotency-Key — a pickup call now, while READY. */
export async function POST(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await recordPickupReminder(principal, id, { outcome: b.outcome, note: b.note }, { idempotencyKey: key }));
  });
}
