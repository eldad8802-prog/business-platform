/**
 * ר1 — POST /api/business-documents/quotes/[id]/share/copies {idempotencyKey} → a NEW copy of the quote, rendered
 * by the existing quote PDF functions, stored before it is shared. Reads the billing mechanism only (READ ONLY
 * transaction); never numbers a quote. A retry with the same key returns the same copy. Session + flag.
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute, readJsonBody, routeId } from "@/lib/services/business-documents/business-documents-http";
import { prepareQuoteShareCopy } from "@/lib/services/business-documents/quote-share/quote-share-copy.service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId, userId }) => {
    const quoteId = routeId((await params).id);
    if (quoteId === null) return NextResponse.json({ error: "NOT_FOUND", message: "לא נמצא" }, { status: 404 });
    const body = await readJsonBody(req, 1_000);
    const copy = await prepareQuoteShareCopy({ businessId, userId, quoteId, idempotencyKey: String(body.idempotencyKey ?? "") });
    return NextResponse.json(copy, { status: copy.replay ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  });
}
