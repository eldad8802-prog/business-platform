import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  extensionFromMime,
  putPublicAsset,
} from "@/lib/services/storage/public-asset-storage.service";
import { StorageConfigError } from "@/lib/storage/storage.errors";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      throw new ValidationError("Missing file");
    }

    if (file.size <= 0) {
      throw new ValidationError("Empty file");
    }

    if (file.size > MAX_BYTES) {
      throw new ValidationError("File too large");
    }

    const mime = file.type;
    if (!extensionFromMime(mime)) {
      throw new ValidationError("Unsupported file type");
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    const stored = await putPublicAsset({
      businessId: user.businessId,
      domain: "offers",
      body: bytes,
      contentType: mime,
      custom: { source: "offer_image_upload" },
    });

    return NextResponse.json({ url: stored.publicUrl }, { status: 201 });
  } catch (error) {
    if (error instanceof StorageConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return handleError(error);
  }
}
