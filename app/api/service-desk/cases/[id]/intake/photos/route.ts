import { PHOTO_UPLOAD_MAX_BYTES, addIntakePhoto } from "@/lib/services/service-desk/intake.service";
import { ServiceDeskError } from "@/lib/services/service-desk/service-desk-errors";
import { idempotencyKeyOf, json, positiveId, readBodyCapped, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/**
 * POST ?expectedVersion=N + Idempotency-Key, body = the image bytes, Content-Type image/jpeg | image/png | image/webp —
 * one intake photo (1.3b). Binary, not base64: a request body is capped at 4.5 MB by the platform, so the screen downsizes
 * and the server reads at most PHOTO_UPLOAD_MAX_BYTES (a running cap, chunked bodies included). The bytes decide the type.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const raw = new URL(req.url).searchParams.get("expectedVersion");
    const expectedVersion = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const bytes = await readBodyCapped(req, PHOTO_UPLOAD_MAX_BYTES);
    if (bytes === null) throw new ServiceDeskError("REFUSED", { violations: ["PHOTO_TOO_LARGE"] });
    const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    return json(await addIntakePhoto(principal, id, { bytes, declaredMime: mime, expectedVersion }, { idempotencyKey: key }));
  });
}
