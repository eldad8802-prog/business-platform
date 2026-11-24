/**
 * The plan gate at an HTTP edge (subscriptions stage C). SERVER-ONLY. A module's own route wrapper calls it right after
 * its flag check:
 *     const planDenied = await planRefusalFor(req, businessId, PLATFORM_FEATURE_KEYS.X);
 *     if (planDenied) return planDenied;
 * Returns null to continue (always, except enforce + a CUSTOMER whose plan lacks the action), or the 403 to return.
 * Never throws: an error inside the plan layer lets the request through (the flag gate already decided).
 */
import { NextResponse } from "next/server";

import type { PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

import { planActionForRequest, planGate, planRefusalBody } from "./plan-gate";

export async function planRefusalFor(req: Request, businessId: number, featureKey: PlatformFeatureKey): Promise<NextResponse | null> {
  try {
    let site = "route";
    try {
      site = new URL(req.url).pathname;
    } catch {
      /* keep "route" */
    }
    const answer = await planGate(businessId, featureKey, planActionForRequest(req.method, site), site);
    if (answer.allowed) return null;
    return NextResponse.json(planRefusalBody(featureKey, answer), { status: 403, headers: { "Cache-Control": "no-store" } });
  } catch {
    return null;
  }
}
