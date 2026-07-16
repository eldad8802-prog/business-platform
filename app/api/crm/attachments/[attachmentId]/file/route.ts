import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { crmAttachmentsService } from "@/lib/services/crm/crm-attachments.service";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ attachmentId: string }> };

/** Keep only printable ASCII for the legacy `filename=` fallback. */
function asciiFallback(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126 && ch !== '"') out += ch;
  }
  return out.trim() || "file";
}

/** RFC 5987: ASCII fallback + UTF-8 (Hebrew) name. Mirrors the billing PDF route. */
function contentDisposition(name: string): string {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Authenticated download — streams bytes through the app (no public/signed key exposure). */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { attachmentId } = await ctx.params;

    const { body, contentType, displayFileName } =
      await crmAttachmentsService.getAttachmentForDownload({
        businessId: user.businessId,
        attachmentId: Number(attachmentId),
      });

    // Copy into a fresh, non-shared ArrayBuffer so the body is a plain
    // BufferSource (TS 5.7+ tightened Buffer/Uint8Array assignability to BodyInit).
    const ab = new ArrayBuffer(body.byteLength);
    new Uint8Array(ab).set(body);
    return new NextResponse(ab, {
      status: 200,
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "Content-Disposition": contentDisposition(displayFileName),
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
