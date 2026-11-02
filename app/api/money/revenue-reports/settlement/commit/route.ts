import { commitRevenueReport } from "@/lib/revenue-sources/uploads/service";
import { json, readReportForm, reportRoute } from "@/lib/revenue-sources/uploads/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

/**
 * Step 2 of a card settlement report upload: the same file, the token from step 1, and the owner's decision on every
 * settlement that conflicts with one already recorded. One transaction: new settlements are recorded as revenue
 * evidence (never as income, never as a bank line); a repeated commit reports the first outcome.
 */
export async function POST(req: Request) {
  return reportRoute(req, ["settlement"], async (actor) => {
    const { input, token, decisions } = await readReportForm(req, actor, "settlement");
    const result = await commitRevenueReport({ ...input, token, decisions });
    return json(result, result.replayed ? 200 : 201);
  });
}
