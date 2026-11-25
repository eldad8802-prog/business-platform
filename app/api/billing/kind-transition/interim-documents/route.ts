/**
 * 4a T4 — documents issued between the official status date and the Dubiz update. Read only.
 * Flag OFF → 404 before the session is read. The business is the session user's (user.businessId), never the request's.
 */
import { NextResponse } from "next/server";

import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { isBusinessKindTransitionEnabled } from "@/lib/legal-identity/kind-transition-flag";
import { defaultInterimDocumentsDeps, handleInterimDocumentsGet } from "@/lib/services/billing/kind-transition/interim-documents-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isBusinessKindTransitionEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);
  const session = { user: { id: user.id, businessId: user.businessId } };
  return handleInterimDocumentsGet(req, { ...defaultInterimDocumentsDeps, context: async () => session });
}
