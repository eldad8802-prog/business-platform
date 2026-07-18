import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { executeAuthorityDecision } from "@/lib/services/billing/authority/billing-authority-decision.service";
import {
  INVOICE_DECISION_ACTIONS,
  type InvoiceDecisionAction,
} from "@/lib/services/billing/authority/billing-authority-decision.types";

// Narrow, guarded endpoint exposing ONLY the three held-decision actions. Auth
// and tenant isolation come from getCurrentUser + user.businessId (never a
// client-supplied business/tenant). No Approval retry, no other actions.
export const runtime = "nodejs";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid billing document id");
  }
  return num;
}

function parseAction(value: unknown): InvoiceDecisionAction {
  if (
    typeof value === "string" &&
    (INVOICE_DECISION_ACTIONS as readonly string[]).includes(value)
  ) {
    return value as InvoiceDecisionAction;
  }
  throw new ValidationError("action must be one of: Cancel, Continue, FurtherObjection");
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const billingDocumentId = parseBillingDocumentId(id);

    const body = (await req.json().catch(() => ({}))) as { action?: unknown };
    const action = parseAction(body.action);

    const authorityDecision = await executeAuthorityDecision({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
      action,
    });

    // The decision OUTCOME is in the body (HTTP 200 = the request was processed);
    // consumers must read `authorityDecision.outcome`, never assume success.
    return NextResponse.json({ authorityDecision }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
