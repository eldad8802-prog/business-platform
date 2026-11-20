import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { recordQa } from "@/lib/services/service-desk/service-case.service";
import { getCaseQa } from "@/lib/services/service-desk/case-extras.service";

/** GET — the checklist this case is judged by (its track snapshot, else its kind) and what was recorded. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getCaseQa(principal.businessId, positiveId((await context.params).id))));
}

/**
 * PUT { results: { <itemKey>: "PASS" | "FAIL" }, expectedVersion } + Idempotency-Key — QA results against the kind's base
 * template (P3), while the case is in QA. QA counts as completed only when every required item is PASS. Journaled (P4).
 */
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await recordQa(principal, id, { results: b.results, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
