import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { authorizePaymentAction, PAYMENT_ACTIONS } from "@/lib/services/payments/payment-authorization";
import { loadCollectionInbox } from "@/lib/services/billing/collection/collection-inbox.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The collection action inbox (/collection): צריך לגבות · ממתין · דורש טיפול · שולם.
 * Business-scoped from the authenticated actor only. `paidBefore` pages the
 * bounded paid history backwards.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);
    const raw = req.nextUrl.searchParams.get("paidBefore");
    let paidBefore: Date | null = null;
    if (raw) {
      paidBefore = new Date(raw);
      if (Number.isNaN(paidBefore.getTime())) throw new ValidationError("Invalid paidBefore");
    }
    const inbox = await loadCollectionInbox(actor.businessId, { paidBefore });
    return NextResponse.json(inbox, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
