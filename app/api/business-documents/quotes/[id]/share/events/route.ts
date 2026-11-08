/**
 * ר1 — POST /api/business-documents/quotes/[id]/share/events {idempotencyKey, kind, copyId?, channel?, note?,
 * correctsEventId?} → the owner's manual record (download, share sheet opened, marked sent BY THE OWNER, a response,
 * a note, a correction). Never proof of delivery or reading. Session + flag.
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute, readJsonBody, routeId } from "@/lib/services/business-documents/business-documents-http";
import { recordQuoteShareEvent } from "@/lib/services/business-documents/quote-share/quote-share-events.service";
import { parseShareEventInput } from "@/lib/services/business-documents/quote-share/quote-share-state";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId, userId }) => {
    const quoteId = routeId((await params).id);
    if (quoteId === null) return NextResponse.json({ error: "NOT_FOUND", message: "לא נמצא" }, { status: 404 });
    const body = await readJsonBody(req, 8_000);
    const event = parseShareEventInput(body);
    const r = await recordQuoteShareEvent({ businessId, userId, quoteId, idempotencyKey: String(body.idempotencyKey ?? ""), event });
    return NextResponse.json(r, { status: r.replay ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  });
}
