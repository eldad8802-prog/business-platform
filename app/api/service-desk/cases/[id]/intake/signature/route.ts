import { readIntakeObject } from "@/lib/services/service-desk/intake.service";
import { PRIVATE_IMAGE_HEADERS, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** GET — the customer's intake signature PNG (1.3b), only through this case's own intake row; private, never cached. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const o = await readIntakeObject(principal.businessId, id, { kind: "signature" });
    return new Response(new Uint8Array(o.bytes), { status: 200, headers: { "Content-Type": o.contentType, ...PRIVATE_IMAGE_HEADERS } });
  });
}
