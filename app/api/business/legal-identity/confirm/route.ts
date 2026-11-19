/**
 * POST /api/business/legal-identity/confirm — the controlled completion for an EXISTING business: confirm (and
 * from then on lock) the legal identity it already has. See lib/services/account/legal-identity-completion.service.ts.
 *
 * OFF unless LEGAL_IDENTITY_COMPLETION_ENABLED=true (separate owner approval): answers 404 exactly like a route
 * that does not exist. The tenant and the user are the session's; the body is ignored — it carries no value.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import {
  confirmExistingLegalIdentity,
  isLegalIdentityCompletionEnabled,
} from "@/lib/services/account/legal-identity-completion.service";
import { safeErrorSummary } from "@/lib/security/log-safe-error";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!isLegalIdentityCompletionEnabled()) {
    return NextResponse.json({ error: "Not Found" }, { status: 404, headers: noStore });
  }
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  try {
    const result = await confirmExistingLegalIdentity(user.businessId, user.id);
    const status = result === "CONFIRMED" || result === "ALREADY_CONFIRMED" ? 200 : result === "NOT_ALLOWED" ? 403 : 422;
    return NextResponse.json({ result }, { status, headers: noStore });
  } catch (error) {
    console.error("LEGAL_IDENTITY_CONFIRM_ERROR:", safeErrorSummary(error));
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: noStore });
  }
}
