import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ROLLBACK_KEY_PATTERN, rollbackLandingVersion } from "@/lib/services/landing/persistence/landing-page.service";
import { LANDING_NO_STORE, landingErrorResponse, versionIdParam, versionNotFound } from "@/lib/services/landing/persistence/landing-http";

/**
 * P3-E — restore an earlier approved version: a NEW version is created from its snapshot and becomes the
 * approved one, atomically. The body is never read. `Idempotency-Key` (optional, [A-Za-z0-9_-]{8,128})
 * makes a double submit of one owner action a single version; without it every call is its own action.
 * No model call.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);
  const id = await versionIdParam(params);
  if (id === null) return versionNotFound();
  const header = req.headers.get("idempotency-key");
  if (header !== null && !ROLLBACK_KEY_PATTERN.test(header)) {
    return NextResponse.json({ error: "Invalid Idempotency-Key", code: "INVALID_IDEMPOTENCY_KEY" }, { status: 400, headers: LANDING_NO_STORE });
  }
  try {
    const result = await rollbackLandingVersion({ businessId: user.businessId, userId: user.id, sourceVersionId: id, clientKey: header ?? randomUUID() });
    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201, headers: LANDING_NO_STORE });
  } catch (error) {
    return landingErrorResponse(error, "POST /api/business/landing/versions/[id]/rollback");
  }
}
