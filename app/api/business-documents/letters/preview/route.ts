/**
 * ר2 — POST /api/business-documents/letters/preview → the letter as HTML (for the in-page preview).
 * Stateless: nothing is stored. Session + business_documents flag (404 when off).
 */
import type { NextRequest } from "next/server";

import { businessDocumentsRoute, readJsonBody } from "@/lib/services/business-documents/business-documents-http";
import { parseLetterInput } from "@/lib/services/business-documents/letter/letter.contracts";
import { renderLetterHtml } from "@/lib/services/business-documents/letter/letter.service";

export async function POST(req: NextRequest) {
  return businessDocumentsRoute(req, async ({ businessId }) => {
    const input = parseLetterInput(await readJsonBody(req));
    const html = await renderLetterHtml(businessId, input);
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // The preview is shown in a sandboxed iframe; the document itself runs no script and loads nothing external.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
