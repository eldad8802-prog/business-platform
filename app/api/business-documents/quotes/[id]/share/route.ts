/**
 * ר1 — GET /api/business-documents/quotes/[id]/share → the share screen: the quote (read only), its stored copies,
 * the owner's manual record, and what that record amounts to on the current version. Session + flag.
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute, routeId } from "@/lib/services/business-documents/business-documents-http";
import { getQuoteShareView } from "@/lib/services/business-documents/quote-share/quote-share-events.service";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const quoteId = routeId((await params).id);
    const view = quoteId === null ? null : await getQuoteShareView(businessId, quoteId);
    if (!view) return NextResponse.json({ error: "NOT_FOUND", message: "לא נמצא" }, { status: 404 });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  });
}
