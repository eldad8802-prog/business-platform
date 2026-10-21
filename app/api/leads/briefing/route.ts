import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getServerI18n } from "@/lib/i18n/server";
import { getLeadBriefing } from "@/lib/services/crm/lead-briefing";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export const runtime = "nodejs";

/**
 * M5 — the Secretary's lead briefing: what needs the owner today and why.
 * Read-only; derived from the lead lifecycle contract at request time.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const businessId = user.businessId;
    const { t } = await getServerI18n();
    const briefing = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction((tx) => getLeadBriefing(tx, businessId, new Date(), t))
    );
    return NextResponse.json(briefing, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
