import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { issueBillingDocument } from "@/lib/services/billing/billing-issue.service";
import { betaIssueGate } from "@/lib/beta/beta-gate";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (
    !num ||
    Number.isNaN(num) ||
    !Number.isInteger(num) ||
    num <= 0
  ) {
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

    // Closed beta: a tax invoice that would need an allocation number is refused BEFORE anything is
    // written (lib/beta/beta-gate.ts). Every other document issues exactly as before.
    const betaRefusal = await betaIssueGate(user.businessId, billingDocumentId);
    if (betaRefusal) return betaRefusal;

    // The document is issued internally inside a transaction; the authority
    // (Approval) call runs post-commit and is reported alongside it. A post-commit
    // authority failure does NOT turn this into an HTTP error — issuance succeeded.
    // Consumers must not assume `200` means the final PDF is deliverable.
    const { document, authority } = await issueBillingDocument({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
    });

    return NextResponse.json({ document, authority }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
