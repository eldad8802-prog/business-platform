import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs/promises";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB

function getExtensionFromMime(mime: string) {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return null;
  }
}

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
    const ext = getExtensionFromMime(mime);

    if (!ext) {
      throw new ValidationError("Unsupported file type");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = `${randomUUID()}.${ext}`;

    const uploadsDir = path.join(
      process.cwd(),
      "public",
      "uploads",
      "offers"
    );
    await fs.mkdir(uploadsDir, { recursive: true });

    const fullPath = path.join(uploadsDir, filename);
    await fs.writeFile(fullPath, bytes);

    const url = `/uploads/offers/${filename}`;

    return NextResponse.json({ url }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

