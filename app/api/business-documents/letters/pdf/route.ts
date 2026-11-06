/**
 * ר2 — POST /api/business-documents/letters/pdf → the letter as a PDF (download / manual share).
 * Stateless: nothing is stored, nothing is numbered, nothing is sent. Session + flag (404 when off).
 */
import type { NextRequest } from "next/server";

import { businessDocumentsRoute, readJsonBody } from "@/lib/services/business-documents/business-documents-http";
import { letterFileName, parseLetterInput } from "@/lib/services/business-documents/letter/letter.contracts";
import { renderLetterPdf } from "@/lib/services/business-documents/letter/letter-pdf.service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const input = parseLetterInput(await readJsonBody(req));
    const pdf = await renderLetterPdf(businessId, input);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${letterFileName(input)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
