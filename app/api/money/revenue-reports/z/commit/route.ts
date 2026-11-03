import { commitRevenueReport } from "@/lib/revenue-sources/uploads/service";
import { json, readReportForm, reportRoute } from "@/lib/revenue-sources/uploads/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

/**
 * Step 2 of a Z report upload: the same file, the token from step 1, and the owner's decision on every Z that
 * conflicts with one already recorded (refused without one). One transaction: new Z reports are recorded as revenue
 * evidence (never as income), recorded ones are not written again; a repeated commit reports the first outcome.
 */
export async function POST(req: Request) {
  return reportRoute(req, ["z"], async (actor) => {
    const { input, token, decisions } = await readReportForm(req, actor, "z");
    const result = await commitRevenueReport({ ...input, token, decisions });
    return json(result, result.replayed ? 200 : 201);
  });
}
