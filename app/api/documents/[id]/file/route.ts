import { readFile } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { resolveStoredDocumentFilePath } from "@/lib/services/documents/document-storage-paths";

export const runtime = "nodejs";

// Legacy placeholders (e.g. `/uploads/gmail/<timestamp>`) do not match
// STORED_DOCUMENT_FILENAME_REGEX and return 404 — same as before.

const SAFE_CONTENT_TYPES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
]);

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    const params = await context.params;
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return new Response("Invalid id", { status: 400 });
    }

    const document = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        businessId: true,
        fileUrl: true,
        mimeType: true,
      },
    });

    if (!document) {
      return new Response("Not found", { status: 404 });
    }

    // Cross-tenant guard: only the owning business may stream the file.
    if (document.businessId !== user.businessId) {
      return new Response("Forbidden", { status: 403 });
    }

    const resolved = resolveStoredDocumentFilePath(
      user.businessId,
      document.fileUrl ?? ""
    );

    if (!resolved.ok) {
      return new Response("Source file not available", { status: 404 });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(resolved.absolutePath);
    } catch {
      return new Response("Source file not available", { status: 404 });
    }

    const mimeType = String(document.mimeType || "").toLowerCase();
    const contentType = SAFE_CONTENT_TYPES.has(mimeType)
      ? mimeType
      : "application/octet-stream";

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        // Documents are private financial data; never let shared caches
        // hold them, and never serve a stale copy from a private cache.
        "Cache-Control": "private, no-store",
        "Content-Length": String(bytes.length),
      },
    });
  } catch (e) {
    console.error("DOCUMENT FILE ROUTE ERROR:", e);
    return new Response("Server error", { status: 500 });
  }
}
