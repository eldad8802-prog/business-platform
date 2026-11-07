/**
 * ר1 — GET /api/business-documents/quotes → the business's regular quotes (never Service Desk quotes), newest first,
 * with the last thing the owner recorded on each. Read only. Session + flag.
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute } from "@/lib/services/business-documents/business-documents-http";
import { listShareableQuotes } from "@/lib/services/business-documents/quote-share/quote-share-events.service";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const quotes = await listShareableQuotes(businessId);
    return NextResponse.json({ quotes }, { headers: { "Cache-Control": "no-store" } });
  });
}
