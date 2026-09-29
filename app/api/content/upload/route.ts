import { getCurrentUser } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  BusinessAssetNotFoundError,
  findBusinessAssetByIdempotency,
  recordBusinessAsset,
  requireOwnedContentRun,
} from "@/lib/services/content/business-asset.service";
import {
  extensionFromMime,
  putPublicAsset,
  requirePublicAssetUrl,
} from "@/lib/services/storage/public-asset-storage.service";
import { StorageConfigError } from "@/lib/storage/storage.errors";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

function isAllowedMime(mimeType: string): boolean {
  const m = String(mimeType || "").toLowerCase().trim();
  return m.startsWith("image/") || m.startsWith("video/");
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userLimit = await consumeRateLimit({
      key: `content:upload:user:${user.id}`,
      limit: 30,
      windowMs: 60 * 60_000,
    });
    if (!userLimit.allowed) {
      return Response.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const businessLimit = await consumeRateLimit({
      key: `content:upload:business:${user.businessId}`,
      limit: 200,
      windowMs: 24 * 60 * 60_000,
    });
    if (!businessLimit.allowed) {
      return Response.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;
    const idempotencyKey =
      typeof formData.get("idempotencyKey") === "string"
        ? String(formData.get("idempotencyKey")).trim()
        : "";
    const contentRunRaw = formData.get("contentRunId");
    const contentRunId =
      typeof contentRunRaw === "string" && /^\d+$/.test(contentRunRaw)
        ? Number(contentRunRaw)
        : null;

    if (!file) {
      return Response.json({ error: "No file" }, { status: 400 });
    }

    if (typeof file.type !== "string" || !isAllowedMime(file.type)) {
      return Response.json({ error: "Unsupported file type" }, { status: 400 });
    }

    if (typeof file.size !== "number" || file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: "File too large (max 10MB)" },
        { status: 413 }
      );
    }

    if (!extensionFromMime(file.type)) {
      return Response.json({ error: "Unsupported file type" }, { status: 400 });
    }

    if (contentRunId) {
      await requireOwnedContentRun(user.businessId, contentRunId);
    }

    if (idempotencyKey) {
      const existing = await findBusinessAssetByIdempotency(
        user.businessId,
        idempotencyKey
      );
      if (existing?.storageKey) {
        return Response.json({
          url: requirePublicAssetUrl(existing.storageKey),
          assetId: existing.id,
          origin: existing.origin,
        });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const stored = await putPublicAsset({
      businessId: user.businessId,
      domain: "content",
      body: buffer,
      contentType: file.type,
      custom: { source: "content_upload" },
    });

    const asset = await recordBusinessAsset({
      businessId: user.businessId,
      origin: "OWNER_UPLOAD",
      storageKey: stored.key,
      assetRef: stored.publicUrl,
      contentRunId,
      idempotencyKey: idempotencyKey || null,
    });

    return Response.json({
      url: stored.publicUrl,
      assetId: asset.id,
      origin: asset.origin,
    });
  } catch (err) {
    if (err instanceof BusinessAssetNotFoundError) {
      return Response.json({ error: "Content run not found" }, { status: 404 });
    }
    if (err instanceof StorageConfigError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    console.error(err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }
}
