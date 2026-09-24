import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { receivePublicAssetUpload } from "@/lib/services/storage/public-asset-upload";
import { StorageConfigError } from "@/lib/storage/storage.errors";

/**
 * Offer image upload. Raster images only (png/jpeg/webp/gif), verified from
 * the bytes, rate-limited per user and per business (M-2).
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await receivePublicAssetUpload({
      req,
      user,
      domain: "offers",
      source: "offer_image_upload",
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ url: result.stored.publicUrl }, { status: 201 });
  } catch (error) {
    if (error instanceof StorageConfigError) {
      console.error("[offers-image] storage config error:", error);
      return NextResponse.json(
        { error: "Upload is temporarily unavailable" },
        { status: 503 }
      );
    }
    return handleError(error);
  }
}
