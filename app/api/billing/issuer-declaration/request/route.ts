import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import { REQUEST_MESSAGES } from "@/lib/billing/issuer-declaration/messages";
import { scheduleDelivery } from "@/lib/email/transactional/schedule";
import { handleError } from "@/lib/handle-error";
import { requestDeclarationLink } from "@/lib/services/billing/issuer-declaration/issuer-declaration.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * "Send me the confirmation link" (#1081). The link is bound to the signed-in account, its business and the digest
 * of the statement as stored now; it goes to the account's own address (never one from the request). Nothing is
 * declared here. The database caps links at 3 per account and hour. OFF → 404.
 */
export async function POST(req: Request) {
  if (!isIssuerDeclarationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  try {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    const result = await requestDeclarationLink({ id: user.id, businessId: user.businessId }, new Date());
    if (result.outcome === "SENT") {
      scheduleDelivery(result.emailId, result.businessId);
      return NextResponse.json(
        { outcome: "SENT", message: REQUEST_MESSAGES.SENT, expiresAt: result.expiresAt },
        { status: 200, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { outcome: result.outcome, message: REQUEST_MESSAGES[result.outcome], problems: result.problems ?? [] },
      { status: result.outcome === "NOT_ISSUED" ? 429 : 409, headers: NO_STORE }
    );
  } catch (error) {
    return handleError(error);
  }
}
