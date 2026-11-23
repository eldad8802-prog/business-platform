/**
 * GET /api/business/activity — the business's activity packs: { selection: { primary, additional } | null }.
 * PUT /api/business/activity — replace them: body { primary, additional? } → { selection }.
 *
 * Phase 2 (owner-approved 2026-11-20). DISPLAY ONLY: the packs decide what the Home puts forward and in what order;
 * they never grant a capability, change a price, or turn a feature flag on.
 *
 * Both answer 404 FEATURE_NOT_AVAILABLE unless `activity_packs` is ON for the session's business (OFF by default —
 * turning it on is a separate owner decision). The tenant is the session's business, never the body's. Signup has a
 * single user per business, its owner (lib/services/payments/payment-account-owner.ts), so the signed-in user may
 * change the business's packs exactly as they may change its profile today.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { parseActivitySelection } from "@/lib/activity-packs/activity-packs";
import { loadActivitySelection, saveActivitySelection } from "@/lib/services/activity-packs/activity-profile.service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function featureOn(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.ACTIVITY_PACKS));
    return r.allowed === true;
  } catch {
    return false; // fail closed: an unknown state never opens the feature
  }
}

const NOT_AVAILABLE = () => NextResponse.json({ error: "FEATURE_NOT_AVAILABLE" }, { status: 404, headers: NO_STORE });

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await featureOn(user.businessId))) return NOT_AVAILABLE();
  try {
    const selection = await loadActivitySelection(user.businessId);
    return NextResponse.json({ selection }, { headers: NO_STORE });
  } catch (error) {
    console.error("ACTIVITY_PACKS_GET_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function PUT(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await featureOn(user.businessId))) return NOT_AVAILABLE();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400, headers: NO_STORE });
  }
  const parsed = parseActivitySelection(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  try {
    const selection = await saveActivitySelection(user.businessId, user.id, parsed.value);
    return NextResponse.json({ selection }, { headers: NO_STORE });
  } catch (error) {
    console.error("ACTIVITY_PACKS_PUT_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}
