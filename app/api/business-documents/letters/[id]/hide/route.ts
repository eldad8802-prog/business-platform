/**
 * POST /api/business-documents/letters/[id]/hide → hide a saved letter (once). It is not deleted: its record and file
 * stay until a purge that is not active (retention is not approved). Session + flag.
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute, routeId } from "@/lib/services/business-documents/business-documents-http";
import { hideSavedLetter } from "@/lib/services/business-documents/letter/saved-letters.service";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId, userId }) => {
    const letterId = routeId((await params).id);
    const r = letterId === null ? "NOT_FOUND" : await hideSavedLetter(businessId, userId, letterId);
    if (r === "NOT_FOUND") return NextResponse.json({ error: "NOT_FOUND", message: "לא נמצא" }, { status: 404 });
    return NextResponse.json({ result: r }, { headers: { "Cache-Control": "no-store" } });
  });
}
