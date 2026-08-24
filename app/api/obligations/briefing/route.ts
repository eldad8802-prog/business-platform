import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getBriefing } from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { toBriefingApi } from "@/lib/services/obligations/obligation-api.serializer";

export const runtime = "nodejs";

/** The morning briefing — conclusion first. Read-only; derives the verdict. */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const briefing = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          getBriefing(user.businessId, obligationServiceDeps({ tx }))
        )
    );
    return NextResponse.json(toBriefingApi(briefing), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
