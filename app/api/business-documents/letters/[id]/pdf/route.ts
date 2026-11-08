/**
 * GET /api/business-documents/letters/[id]/pdf → the stored PDF of a saved letter, exactly as stored (refused unless
 * it still matches the recorded digest). Private: session + flag; no public link, no signed URL. Hidden letters are
 * not served.
 */
import { NextResponse, type NextRequest } from "next/server";

import { businessDocumentsRoute, routeId } from "@/lib/services/business-documents/business-documents-http";
import { readCommittedFile } from "@/lib/services/business-documents/files/business-docs-files";
import { savedLetterFile } from "@/lib/services/business-documents/letter/saved-letters.service";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const letterId = routeId((await params).id);
    const letter = letterId === null ? null : await savedLetterFile(businessId, letterId);
    if (!letter) return NextResponse.json({ error: "NOT_FOUND", message: "לא נמצא" }, { status: 404 });
    const bytes = await readCommittedFile(businessId, letter.fileId);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="letter-${letterId}.pdf"; filename*=UTF-8''${encodeURIComponent(`מכתב-${letterId}.pdf`)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
