import { getCurrentUser } from "@/lib/auth";
import { receivePublicAssetUpload } from "@/lib/services/storage/public-asset-upload";
import { StorageConfigError } from "@/lib/storage/storage.errors";

/**
 * Content media upload (photos + videos for the content/render flow).
 * Acceptance, magic-byte verification, rate limits and serving metadata are
 * owned by receivePublicAssetUpload / putPublicAsset (M-2).
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await receivePublicAssetUpload({
      req,
      user,
      domain: "content",
      source: "content_upload",
    });
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json({ url: result.stored.publicUrl });
  } catch (err) {
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
