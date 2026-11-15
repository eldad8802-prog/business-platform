import { createIntakeSlip, readIntakeSlip } from "@/lib/services/service-desk/intake-slip.service";
import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** GET — the stored intake slip PDF (1.3b-B), only through this case's own intake row; private, never cached. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const s = await readIntakeSlip(principal.businessId, id);
    return new Response(new Uint8Array(s.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="intake-${s.caseNumber}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

/** POST { expectedVersion } + Idempotency-Key — render and store the slip of a SIGNED intake, once (1.3b-B). */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await createIntakeSlip(principal, id, { expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
