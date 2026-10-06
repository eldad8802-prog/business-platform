import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";
import { resolveReversalManually } from "@/lib/services/payments/payment-refund.service";
import { paymentRefundDeps } from "@/lib/services/payments/payments.deps";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function positiveInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return n;
}

/**
 * Resolve an indeterminate refund from evidence at the provider.
 *
 * The way out for a reversal the provider cannot be ASKED about (CardCom, when
 * the answer to RefundByTransactionId was lost and no reversal id came back).
 * Platform administrator with MFA only — never a business owner — and the
 * administrator must state what they observed in the provider's own portal.
 * Only a still-PENDING reversal can be resolved, so this can never overwrite
 * an outcome the provider established; the act is written to both the
 * payment's audit trail (with the evidence) and the platform audit log.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }

    const businessId = positiveInt(body.businessId, "businessId");
    const requestId = positiveInt(body.requestId, "requestId");
    const reversalId = positiveInt(body.reversalId, "reversalId");
    const outcome = body.outcome;
    if (outcome !== "REFUNDED" && outcome !== "REJECTED") {
      throw new ValidationError("outcome must be REFUNDED or REJECTED");
    }
    const evidence = typeof body.evidence === "string" ? body.evidence : "";
    const providerRefundId =
      typeof body.providerRefundId === "string" ? body.providerRefundId : null;

    const result = await runWithTenantContext({ businessId }, () =>
      resolveReversalManually(
        {
          businessId,
          requestId,
          reversalId,
          outcome,
          evidence,
          providerRefundId,
          adminUserId: auth.id,
        },
        paymentRefundDeps()
      )
    );

    await logPlatformAuditEvent({
      actorUserId: auth.id,
      action: PLATFORM_AUDIT_ACTIONS.PAYMENT_REVERSAL_RESOLVED,
      targetType: "PAYMENT_REVERSAL",
      targetId: String(reversalId),
      metadata: { businessId, requestId, outcome, status: result.status },
      req,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
