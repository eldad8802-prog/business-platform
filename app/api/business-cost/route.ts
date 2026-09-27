import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  deriveBusinessCost,
  serializeBusinessCostDay,
} from "@/lib/services/business-cost/business-cost.service";
import { BusinessCostValidationError } from "@/lib/services/business-cost/business-cost-core";

export const runtime = "nodejs";

/**
 * GET /api/business-cost?date=YYYY-MM-DD — what this business costs on a date.
 *
 * Read-only. Returns the allocated cost, the baseline daily cost, the cash that
 * actually left, and every line each figure is made of. The business is the
 * session's, never a parameter: there is no way to ask about another business.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const raw = req.nextUrl.searchParams.get("date");
    if (raw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new ValidationError("date must be YYYY-MM-DD");
    }

    const day = await runWithTenantContext({ businessId: user.businessId }, () =>
      deriveBusinessCost({ businessId: user.businessId, date: raw }),
    );

    return NextResponse.json(serializeBusinessCostDay(day));
  } catch (error) {
    if (error instanceof BusinessCostValidationError) {
      return handleError(new ValidationError(error.message));
    }
    return handleError(error);
  }
}
