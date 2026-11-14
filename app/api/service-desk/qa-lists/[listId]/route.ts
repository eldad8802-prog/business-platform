import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getQaList, reviseQaList } from "@/lib/services/service-desk/qa-lists.service";

/** GET ?version= — one QA list: the current version (or that one) with its checks, every version, its change history, its use. */
export async function GET(req: Request, context: { params: Promise<{ listId: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const id = positiveId((await context.params).listId);
    const v = new URL(req.url).searchParams.get("version");
    return json(await getQaList(principal.businessId, id, { version: v === null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : v }));
  });
}

/**
 * PUT { expectedRevision, name, items: [{ key?, label, required }] } + Idempotency-Key — the list's next version, whole
 * (rename; checks added, removed, reordered, relabelled; REQUIRED per check). Older versions, and every case checked
 * against them, never change. Journaled (REVISE).
 */
export async function PUT(req: Request, context: { params: Promise<{ listId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).listId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await reviseQaList(principal, id, { expectedRevision: b.expectedRevision, name: b.name, items: b.items }, { idempotencyKey: key }));
  });
}
