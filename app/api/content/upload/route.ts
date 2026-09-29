import { getCurrentUser } from "@/lib/auth";
import {
  BusinessAssetNotFoundError,
  findBusinessAssetByIdempotency,
  recordBusinessAsset,
  requireOwnedContentRun,
} from "@/lib/services/content/business-asset.service";
import { requirePublicAssetUrl } from "@/lib/services/storage/public-asset-storage.service";
import { receivePublicAssetUpload } from "@/lib/services/storage/public-asset-upload";
import { StorageConfigError } from "@/lib/storage/storage.errors";

/** An idempotent replay: the asset already exists; nothing new is stored. */
class IdempotentReplay {
  constructor(readonly body: { url: string; assetId: number; origin: string }) {}
}

/**
 * Content media upload (photos + videos for the content/render flow).
 * Acceptance, magic-byte verification, rate limits and serving metadata are
 * owned by receivePublicAssetUpload / putPublicAsset (M-2). The P0 provenance
 * fields (contentRunId, idempotencyKey) are checked in its beforeStore hook —
 * after the rate limits and size prechecks, before any byte is stored.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let idempotencyKey = "";
    let contentRunId: number | null = null;

    const result = await receivePublicAssetUpload({
      req,
      user,
      domain: "content",
      source: "content_upload",
      beforeStore: async (form) => {
        const key = form.get("idempotencyKey");
        idempotencyKey = typeof key === "string" ? key.trim() : "";
        const run = form.get("contentRunId");
        contentRunId = typeof run === "string" && /^\d+$/.test(run) ? Number(run) : null;

        if (contentRunId) {
          await requireOwnedContentRun(user.businessId, contentRunId);
        }
        if (idempotencyKey) {
          const existing = await findBusinessAssetByIdempotency(user.businessId, idempotencyKey);
          if (existing?.storageKey) {
            throw new IdempotentReplay({
              url: requirePublicAssetUrl(existing.storageKey),
              assetId: existing.id,
              origin: existing.origin,
            });
          }
        }
      },
    });
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    const asset = await recordBusinessAsset({
      businessId: user.businessId,
      origin: "OWNER_UPLOAD",
      storageKey: result.stored.key,
      assetRef: result.stored.publicUrl,
      contentRunId,
      idempotencyKey: idempotencyKey || null,
    });

    return Response.json({
      url: result.stored.publicUrl,
      assetId: asset.id,
      origin: asset.origin,
    });
  } catch (err) {
    if (err instanceof IdempotentReplay) {
      return Response.json(err.body);
    }
    if (err instanceof BusinessAssetNotFoundError) {
      return Response.json({ error: "Content run not found" }, { status: 404 });
    }
    if (err instanceof StorageConfigError) {
      console.error("[content-upload] storage config error:", err);
      return Response.json(
        { error: "Upload is temporarily unavailable" },
        { status: 503 }
      );
    }
    console.error(err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }
}
