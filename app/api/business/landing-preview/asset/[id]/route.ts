import { getCurrentUser } from "@/lib/auth";
import { getStorageService } from "@/lib/storage";
import { assertSafeStorageKey } from "@/lib/storage/key-validation";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import { resolvePreviewAsset } from "@/lib/services/landing/renderer/preview-asset";

export const runtime = "nodejs";

/** Images only — a landing preview never streams documents or anything executable. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };

/**
 * P3-D — stream ONE public-use-approved BusinessAsset of the SESSION business to the owner's landing
 * preview. Owner-only (Bearer session); the asset must belong to the session business (tenant
 * transaction + explicit check), be publicUseApproved, and have a storage key under the business's own
 * prefix. Never a redirect, never a public URL, never a key in the response; no URL is ever fetched
 * on the asset's behalf.
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return new Response("Unauthorized", { status: 401, headers: HEADERS });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Invalid id", { status: 400, headers: HEADERS });

  const asset = await resolvePreviewAsset(user.businessId, id);
  if (!asset) return new Response("Not found", { status: 404, headers: HEADERS });
  const key = asset.storageKey;

  try {
    const object = await getStorageService().getObject(assertSafeStorageKey(key));
    const type = String(object.metadata.contentType || "").toLowerCase();
    if (!IMAGE_TYPES.has(type)) return new Response("Not available", { status: 404, headers: HEADERS });
    return new Response(new Uint8Array(object.body), { status: 200, headers: { ...HEADERS, "Content-Type": type } });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) return new Response("Not available", { status: 404, headers: HEADERS });
    throw error;
  }
}
