/**
 * ר2 — POST /api/business-documents/letters/pdf → the letter as a PDF (download / manual share).
 * Stateless: nothing is stored, nothing is numbered, nothing is sent. Session + flag (404 when off).
 */
import type { NextRequest } from "next/server";

import { businessDocumentsRoute, readJsonBody } from "@/lib/services/business-documents/business-documents-http";
import { letterFileName, parseLetterInput } from "@/lib/services/business-documents/letter/letter.contracts";
import { renderLetterPdf } from "@/lib/services/business-documents/letter/letter-pdf.service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return businessDocumentsRoute(req, async ({ businessId, userId }) => {
    // Owner decision 26: abuse ceiling after auth + flag, before Chromium starts. Fail-open bucket.
    const rateDecision = await checkRateLimit({ bucket: "LETTER_PREVIEW", user: userId, business: businessId });
    if (!rateDecision.allowed) return buildRateLimitResponse(rateDecision);
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
