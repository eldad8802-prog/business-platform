import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import { runWithTenantContext } from "@/lib/tenant/context";
import { BusinessCostValidationError } from "@/lib/services/business-cost/business-cost-core";
import {
  deriveBusinessCostRange,
  deriveBusinessCostSummary,
  serializeMoney,
} from "@/lib/services/business-cost/business-cost-intelligence.service";

export const runtime = "nodejs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/business-cost/summary[?date=YYYY-MM-DD][&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *
 * Read-only business cost intelligence for the session's business: cash out and
 * allocated cost for today / yesterday / this week / this month / last 30 days
 * (and an optional custom range), the normalised recurring baseline, upcoming
 * obligations, cost structure, recorded changes, history-relative signals and
 * the deterministic insights composed from them. The business is the session's,
 * never a parameter. No profit, margin or break-even is computed here.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const params = req.nextUrl.searchParams;
    const date = params.get("date");
    const from = params.get("from");
    const to = params.get("to");
    for (const [name, v] of [["date", date], ["from", from], ["to", to]] as const) {
      if (v !== null && !DATE.test(v)) throw new ValidationError(`${name} must be YYYY-MM-DD`);
    }
    if ((from === null) !== (to === null)) throw new ValidationError("from and to go together");
    if (from && to && to < from) throw new ValidationError("to must not be before from");

    const businessId = user.businessId;
    const result = await runWithTenantContext({ businessId }, async () => {
      const { summary, insights } = await deriveBusinessCostSummary({ businessId, date });
      const range = from && to ? await deriveBusinessCostRange({ businessId, from, to }) : null;
      return { ...summary, range, insights };
    });
    return NextResponse.json(serializeMoney(result));
  } catch (error) {
    if (error instanceof BusinessCostValidationError || error instanceof RangeError) {
      return handleError(new ValidationError(error.message));
    }
    return handleError(error);
  }
}
