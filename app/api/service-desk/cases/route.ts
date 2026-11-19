import { idempotencyKeyOf, json, jsonBody, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { listCases, openCase } from "@/lib/services/service-desk/service-case.service";

const num = (v: string | null) => (v === null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : v);

/** GET ?status=&beforeId=&limit= — the business's cases, newest first. */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const q = new URL(req.url).searchParams;
    return json(await listCases(principal.businessId, { status: q.get("status") ?? undefined, beforeId: num(q.get("beforeId")), limit: num(q.get("limit")) }));
  });
}

/** POST { kind, customerId, deviceId?, parentCaseId?, problemDescription? } + Idempotency-Key — open a case. */
export async function POST(req: Request) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const r = await openCase(principal, {
      kind: b.kind, customerId: b.customerId, deviceId: b.deviceId, parentCaseId: b.parentCaseId, problemDescription: b.problemDescription,
      // M1: opening on a track (the server takes the profile snapshot; the request cannot name requirements)
      track: b.track, serviceLocation: b.serviceLocation, siteAddress: b.siteAddress, siteNotes: b.siteNotes,
      returnReason: b.returnReason, originalSaleRef: b.originalSaleRef, subject: b.subject,
    }, { idempotencyKey: key });
    return json(r, r.replayed ? 200 : 201);
  });
}
