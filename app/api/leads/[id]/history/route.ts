import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { getLeadLifecycleHistory } from "@/lib/services/crm/lead-lifecycle.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export const runtime = "nodejs";

/**
 * M5 — the full lifecycle history of one lead, newest first. Categories, times
 * and amounts only (no names, phones, notes or message content). Tenant-scoped:
 * a lead of another business answers exactly like a missing one.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const { id } = await context.params;
    const leadId = Number(id);
    if (!Number.isInteger(leadId) || leadId <= 0) throw new ValidationError("Invalid lead id");
    const businessId = user.businessId;
    const history = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction(async (tx) => {
        const lead = await tx.lead.findFirst({ where: { id: leadId, businessId }, select: { id: true } });
        if (!lead) throw new NotFoundError("Lead not found");
        return getLeadLifecycleHistory(tx, businessId, leadId, 200);
      })
    );
    return NextResponse.json({ items: history }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
