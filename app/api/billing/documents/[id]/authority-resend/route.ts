import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { resendAuthorityApproval } from "@/lib/services/billing/authority/billing-authority-resend.service";

// Narrow, guarded endpoint: resend ONE allocation request that provably never
// reached the Tax Authority (READY never sent, or FAILED[AUTHORITY_NOT_SENT_*]).
// Any other state is refused 409 before anything runs. Auth and tenant isolation
// come from getCurrentUser + user.businessId (never a client-supplied business).
// Same permission as issuing the document. No body. Every pilot gate (business,
// operation, N10 document list), the re-entry gate and the reserve apply inside
// the execution service exactly as at issue.
export const runtime = "nodejs";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid billing document id");
  }
  return num;
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

    const result = await resendAuthorityApproval({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
    });

    // HTTP 200 = one attempt was processed; the OUTCOME is in `authority.status`
    // (it may be another not-sent refusal, an uncertain outcome, etc.).
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
