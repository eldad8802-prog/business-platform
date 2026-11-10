/**
 * GET /api/business-documents/po-sheets/[id]/pdf → the STORED file of a saved copy, exactly as stored (refused unless it
 * still matches the recorded digest) — never a re-rendering. Private: session + flag; no public link, no signed URL.
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute, routeId } from "@/lib/services/business-documents/business-documents-http";
import { readCommittedFile } from "@/lib/services/business-documents/files/business-docs-files";
import { purchaseOrderSheetFile } from "@/lib/services/business-documents/po-sheet/po-sheet.service";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const sheetId = routeId((await params).id);
    const sheet = sheetId === null ? null : await purchaseOrderSheetFile(businessId, sheetId);
    if (!sheet) return NextResponse.json({ error: "NOT_FOUND", message: "לא נמצא" }, { status: 404 });
    const bytes = await readCommittedFile(businessId, sheet.fileId);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="supplier-order-${sheet.supplierOrderId}-copy-${sheetId}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
