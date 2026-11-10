import { readIntakeObject } from "@/lib/services/service-desk/intake.service";
import { positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** GET — one intake photo's bytes (1.3b), only through this case's own photo row; private, never cached. */
export async function GET(req: Request, context: { params: Promise<{ id: string; photoId: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const { id, photoId } = await context.params;
    const o = await readIntakeObject(principal.businessId, positiveId(id), { kind: "photo", photoId: positiveId(photoId) });
    return new Response(new Uint8Array(o.bytes), { status: 200, headers: { "Content-Type": o.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  });
}
