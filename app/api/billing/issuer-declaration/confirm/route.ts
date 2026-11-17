import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import { CONFIRM_MESSAGES, SIGN_IN_REQUIRED_MESSAGE } from "@/lib/billing/issuer-declaration/messages";
import { handleError } from "@/lib/handle-error";
import { confirmDeclaration } from "@/lib/services/billing/issuer-declaration/issuer-declaration.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/** Database refusals of the declaration INSERT (the migration's DZD3x codes). The spend rolled back with it. */
const DB_REFUSAL = /ISSUER_[A-Z_]+/;
const NOT_RECORDED_MESSAGE = "ההצהרה לא נשמרה והקישור לא נוצל. אפשר לנסות שוב, ואם זה חוזר — לפנות לתמיכה.";

/**
 * The explicit "I confirm" (#1081). One tenant transaction: lock, recompute the statement from the database,
 * spend the link (signed-in account, its business, same digest), insert the declaration. Anything but CONFIRMED
 * records nothing. The user comes from the session, never from the body. OFF → 404.
 */
export async function POST(req: Request) {
  if (!isIssuerDeclarationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ outcome: "SIGN_IN_REQUIRED", message: SIGN_IN_REQUIRED_MESSAGE }, { status: 401, headers: NO_STORE });
    }
    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    let result;
    try {
      result = await confirmDeclaration({ id: user.id, businessId: user.businessId }, body.token, new Date());
    } catch (error) {
      if (error instanceof Error && DB_REFUSAL.test(error.message)) {
        return NextResponse.json({ outcome: "NOT_RECORDED", message: NOT_RECORDED_MESSAGE }, { status: 409, headers: NO_STORE });
      }
      throw error;
    }
    return NextResponse.json(
      { outcome: result.outcome, message: CONFIRM_MESSAGES[result.outcome] },
      { status: result.outcome === "CONFIRMED" ? 200 : 409, headers: NO_STORE }
    );
  } catch (error) {
    return handleError(error);
  }
}
