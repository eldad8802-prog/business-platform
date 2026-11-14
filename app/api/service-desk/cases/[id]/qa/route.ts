import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { recordQa } from "@/lib/services/service-desk/service-case.service";
import { getCaseQa } from "@/lib/services/service-desk/qa-lists.service";

/** GET — the case's QA: the track's mode, the checklist it names (its QA list version or built-in template), every record with its per-check results. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getCaseQa(principal.businessId, positiveId((await context.params).id))));
}

/**
 * PUT { results: { <itemKey>: "PASS" | "FAIL" | { result: "PASS" | "FAIL", note? } }, expectedVersion } + Idempotency-Key — QA
 * results against the checklist the case names (its chosen QA list version, else its track's / kind's built-in template),
 * while the case is in QA. QA counts as completed only when every REQUIRED check is PASS. Journaled (P4); each check's
 * result is stored in the case's QA history (migration 20261129090000).
 */
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await recordQa(principal, id, { results: b.results, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
