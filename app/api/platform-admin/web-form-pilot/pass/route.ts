/**
 * POST /api/platform-admin/web-form-pilot/pass — TEMPORARY (website-form live proof, business 9).
 *
 * Canonical Platform-Admin guard (Bearer + PLATFORM_ADMIN + allowlist + MFA). Issues the short pass
 * that opens /lab/web-form-pilot for ONE live website connection of business 9. Writes nothing.
 * See lib/intake/acquisition/web-form-pilot.ts. Remove with the pilot.
 */
import { NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { resolvePublicConnection } from "@/lib/intake/acquisition/resolve";
import { handlePilotPass } from "@/lib/intake/acquisition/web-form-pilot";
import { WEB_FORM_SOURCE } from "@/lib/intake/acquisition/providers/web-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const admin = await requirePlatformAdminOrResponse(req);
  if (admin instanceof NextResponse) return admin;
  return handlePilotPass(req, admin, { resolve: (publicId) => resolvePublicConnection(WEB_FORM_SOURCE, publicId) });
}
