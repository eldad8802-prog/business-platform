import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { getLeadCard } from "@/lib/services/crm/lead-card.read-model";
import { leadService } from "@/lib/services/crm/lead.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

/** Basic identity/context fields editable from the lead card. */
const BASIC_FIELDS = [
  "name",
  "phone",
  "email",
  "intentSnapshot",
  "sourceChannel",
] as const;

/**
 * Lead Card read-model: the lead, its linked customer, its conversations, and
 * the follow-up state derived at read time.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;

    // The whole multi-table card read runs inside ONE tenant transaction:
    // server-derived tenant -> ALS -> tenant transaction (GUC) -> RLS backstop.
    const card = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          getLeadCard(
            { businessId: user.businessId, leadId: Number(id) },
            { tx }
          )
        )
    );

    return NextResponse.json(card, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * PATCH is split by CONTRACT — the same discipline
 * `PATCH /api/customers/[id]` already uses, so each write path stays atomic and
 * separately auditable instead of fanning out into extra endpoints:
 *
 *   - STATUS request     → `{ status, lostReason? }`
 *   - FOLLOW-UP request  → `{ followUpAt: string, followUpNote? }` to set or
 *                          reschedule, or `{ followUpAt: null }` to mark done
 *   - BASICS request     → name / phone / email / intentSnapshot / sourceChannel
 *
 * Mixing two contracts in one request is rejected: they are three different
 * business actions with three different audit events, and a partial multi-service
 * update is exactly what this split exists to prevent.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const leadId = Number(id);

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const has = (key: string) =>
      Object.prototype.hasOwnProperty.call(body, key);

    const hasStatus = has("status");
    const hasFollowUp = has("followUpAt");
    const basics: Record<string, unknown> = {};
    for (const key of BASIC_FIELDS) {
      if (has(key)) basics[key] = body[key];
    }
    const hasBasics = Object.keys(basics).length > 0;

    const contracts = [hasStatus, hasFollowUp, hasBasics].filter(Boolean).length;
    if (contracts === 0) {
      throw new ValidationError(
        "Provide one of: status, followUpAt, or basic lead fields"
      );
    }
    if (contracts > 1) {
      throw new ValidationError(
        "status, followUpAt and basic fields cannot be updated in the same request"
      );
    }

    const businessId = user.businessId;

    const updated = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction((tx) => {
        if (hasStatus) {
          return leadService.updateLeadStatus(
            {
              businessId,
              leadId,
              status: body.status as string,
              lostReason:
                (body.lostReason as string | null | undefined) ?? null,
            },
            { tx }
          );
        }
        if (hasFollowUp) {
          // `followUpAt: null` is the explicit "this follow-up is handled"
          // signal — completion IS clearing the timestamp, so there is no
          // separate reminder row that could fire twice.
          return body.followUpAt === null
            ? leadService.clearFollowUp({ businessId, leadId }, { tx })
            : leadService.setFollowUp(
                {
                  businessId,
                  leadId,
                  followUpAt: body.followUpAt as string,
                  note:
                    (body.followUpNote as string | null | undefined) ?? null,
                },
                { tx }
              );
        }
        return leadService.updateLead(
          { businessId, leadId, ...basics },
          { tx }
        );
      })
    );

    // Re-read through the card model so the client always gets the same shape
    // from GET and PATCH — including the freshly derived follow-up state.
    const card = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction((tx) =>
        getLeadCard({ businessId, leadId: updated.id }, { tx })
      )
    );

    return NextResponse.json(card, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
