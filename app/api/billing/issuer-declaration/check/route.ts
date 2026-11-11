import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { checkIssuerDeclarationLink } from "@/lib/auth/issuer-declaration-link";
import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import { CHECK_MESSAGES, SIGN_IN_REQUIRED_MESSAGE } from "@/lib/billing/issuer-declaration/messages";
import { handleError } from "@/lib/handle-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The confirmation page's first call (#1081): what is this link? Changes nothing. The token arrives in the body
 * (the page reads it from the URL fragment), never in a URL. Signed-in only — the link works only for the account
 * it was sent to, and that is checked again when it is spent. OFF → 404.
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
    return NextResponse.json(
      { status, message: status === "VALID" ? null : CHECK_MESSAGES[status] },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    return handleError(error);
  }
}
