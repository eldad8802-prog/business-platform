/**
 * Business documents (ר1–ר3) — the HTTP edge shared by its routes. SERVER-ONLY.
 *
 *   - authenticated user only (401); the business comes from the session, never from the request;
 *   - the `business_documents` flag: OFF ⇒ 404, as if the route did not exist (fail-closed: any error reads as OFF);
 *   - known errors ⇒ their status and a Hebrew message; anything else ⇒ 500 with no detail.
 */
import { NextResponse, type NextRequest } from "next/server";

import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";

import { LetterValidationError } from "./letter/letter.contracts";

export async function businessDocumentsEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.BUSINESS_DOCUMENTS));
    return r.allowed === true;
  } catch {
    return false;
  }
}

export type BusinessDocumentsContext = { businessId: number; userId: number };

export async function businessDocumentsRoute(req: NextRequest, handler: (ctx: BusinessDocumentsContext) => Promise<Response>): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    if (!(await businessDocumentsEnabled(user.businessId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return await handler({ businessId: user.businessId, userId: user.id });
  } catch (error) {
    if (error instanceof LetterValidationError) {
      return NextResponse.json({ error: "VALIDATION", problems: error.problems }, { status: 400 });
    }
    return handleError(error);
  }
}

/** JSON body, refusing anything that is not a plain object or is larger than `maxBytes`. */
export async function readJsonBody(req: NextRequest, maxBytes = 64_000): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new LetterValidationError([{ field: "body", message: "הטקסט ארוך מדי" }]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LetterValidationError([{ field: "body", message: "בקשה לא תקינה" }]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LetterValidationError([{ field: "body", message: "בקשה לא תקינה" }]);
  }
  return parsed as Record<string, unknown>;
}
