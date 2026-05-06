import { writeFile } from "fs/promises";
import path from "path";
import { getCurrentUser } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/security/rate-limit";

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

    const userLimit = consumeRateLimit({
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

    const businessLimit = consumeRateLimit({
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

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const fileName = `${Date.now()}-${file.name}`;
    const filePath = path.join(process.cwd(), "public/uploads", fileName);

    await writeFile(filePath, buffer);

    const url = `/uploads/${fileName}`;

    return Response.json({ url });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }
}