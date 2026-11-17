import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isIssuerDeclarationEnabled } from "@/lib/billing/issuer-declaration/config";
import { handleError } from "@/lib/handle-error";
import { loadIssuerDeclarationContext } from "@/lib/services/billing/issuer-declaration/issuer-declaration.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The issuer declaration screen's state (#1081): the stored details, what is missing, whether a declaration exists,
 * and — when everything is complete — the exact statement the owner will confirm. Reads only. OFF → 404.
 */
export async function GET(req: Request) {
  if (!isIssuerDeclarationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  try {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    const ctx = await loadIssuerDeclarationContext(user.businessId, user.id);
    return NextResponse.json(
      {
        details: ctx.details,
        problems: ctx.problems,
        declared: ctx.current !== null,
        current: ctx.current,
        precondition: ctx.precondition,
        statement: ctx.statement,
      },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    return handleError(error);
  }
}
