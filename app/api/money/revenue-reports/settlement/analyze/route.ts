import { analyzeRevenueReport } from "@/lib/revenue-sources/uploads/service";
import { json, readReportForm, reportRoute } from "@/lib/revenue-sources/uploads/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

/**
 * Step 1 of a card settlement report upload: find the parser that recognises the file (none is shipped yet:
 * FORMAT_NOT_SUPPORTED), read it, validate every settlement, classify each against what the business holds. ZERO
 * WRITES. Returns the preview and a signed token. 404 while settlement_report_upload is OFF for the session's business.
 */
export async function POST(req: Request) {
  return reportRoute(req, ["settlement"], async (actor) => {
    const { input } = await readReportForm(req, actor, "settlement");
    return json(await analyzeRevenueReport(input));
  });
}
