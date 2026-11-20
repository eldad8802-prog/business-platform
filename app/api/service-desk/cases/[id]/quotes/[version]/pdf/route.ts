import { readQuotePdf } from "@/lib/services/service-desk/quote.service";
import { positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** GET — the stored copy of a sent quote version (the bytes the customer received), only through that version's own row. */
export async function GET(req: Request, context: { params: Promise<{ id: string; version: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const params = await context.params;
    const s = await readQuotePdf(principal.businessId, positiveId(params.id), positiveId(params.version));
    return new Response(new Uint8Array(s.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="quote-${s.caseNumber}-v${s.version}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
