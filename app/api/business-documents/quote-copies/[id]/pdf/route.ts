/**
 * ר1 — GET /api/business-documents/quote-copies/[id]/pdf → the stored bytes of a share copy, exactly as stored
 * (refused unless they still match the recorded digest). Private: session + flag; no public link, no signed URL.
 * ?download=1 → attachment; otherwise inline. Recording "downloaded" / "share sheet opened" is a separate, explicit
 * call from the screen — serving the file records nothing.
 */
import { NextResponse, type NextRequest } from "next/server";

import { bdTx } from "@/lib/services/business-documents/bd-tx";
import { businessDocumentsRoute, routeId } from "@/lib/services/business-documents/business-documents-http";
import { readCommittedFile } from "@/lib/services/business-documents/files/business-docs-files";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const copyId = routeId((await params).id);
    const copy = copyId === null ? null : await bdTx(businessId, (tx) => tx.quoteShareCopy.findFirst({ where: { businessId, id: copyId }, select: { fileId: true, quoteNumberSnapshot: true } }));
    if (!copy) return NextResponse.json({ error: "NOT_FOUND", message: "לא נמצא" }, { status: 404 });
    const bytes = await readCommittedFile(businessId, copy.fileId);
    const ascii = `quote-${copy.quoteNumberSnapshot.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
    const utf8 = encodeURIComponent(`הצעת-מחיר-${copy.quoteNumberSnapshot}.pdf`);
    const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
