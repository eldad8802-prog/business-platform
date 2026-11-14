import { idempotencyKeyOf, json, jsonBody, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { createQaList, listQaLists } from "@/lib/services/service-desk/qa-lists.service";

/** GET ?includeArchived=true — the business's own QA lists (active first). `available: false` before migration 20261129090000. */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const all = new URL(req.url).searchParams.get("includeArchived");
    return json(await listQaLists(principal.businessId, { includeArchived: all === null ? undefined : all === "true" ? true : all === "false" ? false : all }));
  });
}

/**
 * POST { name, items?: [{ key?, label, required }], fromTemplate? } + Idempotency-Key — a new QA list (version 1), empty of
 * history: its own checks, or a COPY of a built-in suggested template's (GET /api/service-desk/qa-templates). Journaled
 * (ServiceQaListEvent CREATE). Without migration 20261129090000: NOT_AVAILABLE_UNTIL_MIGRATION, nothing written.
 */
export async function POST(req: Request) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const r = await createQaList(principal, { name: b.name, items: b.items, fromTemplate: b.fromTemplate }, { idempotencyKey: key });
    return json(r, r.replayed ? 200 : 201);
  });
}
