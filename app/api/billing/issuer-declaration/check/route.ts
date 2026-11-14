import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { checkIssuerDeclarationLink } from "@/lib/auth/issuer-declaration-link";
import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import { CHECK_MESSAGES, SIGN_IN_REQUIRED_MESSAGE } from "@/lib/billing/issuer-declaration/messages";
import { handleError } from "@/lib/handle-error";
import { loadIssuerDeclarationContext } from "@/lib/services/billing/issuer-declaration/issuer-declaration.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The confirmation page's first call (#1081): what is this link, and what would the signed-in account confirm?
 * Changes nothing. The token arrives in the body (the page reads it from the URL fragment), never in a URL.
 * Signed-in only — the link works only for the account it was sent to, and that is checked again when it is spent.
 * For a VALID link the statement and precondition come from the SESSION's business (user.businessId), never from the
 * request — the same view GET /api/billing/issuer-declaration returns. OFF → 404.
 */
export async function POST(req: Request) {
  if (!isIssuerDeclarationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ status: "SIGN_IN_REQUIRED", message: SIGN_IN_REQUIRED_MESSAGE }, { status: 401, headers: NO_STORE });
    }
    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    const status = await checkIssuerDeclarationLink(body.token);
    if (status !== "VALID") {
      return NextResponse.json({ status, message: CHECK_MESSAGES[status] }, { status: 200, headers: NO_STORE });
    }
    const ctx = await loadIssuerDeclarationContext(user.businessId, user.id);
    return NextResponse.json(
      { status, message: null, statement: ctx.statement, precondition: ctx.precondition },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    return handleError(error);
  }
}
