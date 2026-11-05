/**
 * Leads L1.5-a — the platform EMERGENCY SWITCH for the seven intake sources.
 *
 *   GET   the seven states + whether the switch is operational (admin read client)      platform admin
 *   POST  { featureKey, on, expectedOn, reason, confirm }                                platform admin + FRESH MFA (≤ 5 min)
 *         confirm must repeat the featureKey exactly (an explicit, typed confirmation);
 *         expectedOn is the state the admin saw — a change made meanwhile by someone else is refused (409 stale)
 *
 * Order (CI-pinned): identity → fresh step-up → the mutation kill-switch (FEATURE_ACCESS_MUTATIONS_ENABLED) → the
 * OPERATIONAL gate (INTAKE_EMERGENCY_SWITCH_ENABLED = "true"; off by default — the switch may not be used before the
 * hold expiry and monitoring ship and the owner approves its activation) → body validation → an "attempted" audit row
 * → the stale check → the control-plane function (change + its own audit row, one transaction, FG lock first) → on any
 * failure a "failed" audit row. Answers:
 *   200 applied (or already in that state — audited as unchanged)   400 invalid / refused by the database
 *   409 stale (changed meanwhile) or busy (FG lock not free in 5 s) 503 not operational / switch unavailable
 */
import { NextRequest, NextResponse } from "next/server";
import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/security/rate-limit";
import { isFeatureAccessMutationsEnabled } from "@/lib/services/feature-access/feature-access-mutations";
import {
  auditEmergencyAttempt,
  getIntakeEmergencyStates,
  isIntakeEmergencySwitchOperational,
} from "@/lib/services/platform-admin/intake-emergency.service";
import { classifyEmergencyError, setFeatureEmergency, validateEmergencyInput } from "@/lib/services/control-plane/feature-emergency.service";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json(
      { features: await getIntakeEmergencyStates(), operational: isIntakeEmergencySwitchOperational() && isFeatureAccessMutationsEnabled() },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    const stale = freshStepUpRefusal(req, auth.id);
    if (stale) return stale;
    if (!isFeatureAccessMutationsEnabled()) throw new ServiceUnavailableError();
    if (!isIntakeEmergencySwitchOperational()) return NextResponse.json({ error: "not_operational" }, { status: 503 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const input = validateEmergencyInput({ featureKey: body?.featureKey, on: body?.on, reason: body?.reason });
    if (body?.confirm !== input.featureKey) throw new ValidationError("Type the feature key to confirm");
    if (typeof body?.expectedOn !== "boolean") throw new ValidationError("expectedOn must be true or false");

    const ip = getClientIp(req);
    const userAgent = req.headers.get("user-agent");
    await auditEmergencyAttempt({ actorUserId: auth.id, featureKey: input.featureKey, outcome: "attempted", on: input.on, ip, userAgent });
    const failed = (failure: string) =>
      auditEmergencyAttempt({ actorUserId: auth.id, featureKey: input.featureKey, outcome: "failed", on: input.on, failure, ip, userAgent }).catch(() => undefined);

    // Someone changed it since this admin looked: refuse rather than act on a view that is no longer true.
    const current = (await getIntakeEmergencyStates()).find((f) => f.featureKey === input.featureKey);
    if (!current || current.emergencyOn !== body.expectedOn) {
      await failed("stale");
      return NextResponse.json({ error: "stale" }, { status: 409 });
    }
    try {
      const result = await setFeatureEmergency({ ...input, actorUserId: auth.id, ip, userAgent });
      return NextResponse.json({ result }, { status: 200 });
    } catch (error) {
      const failure = classifyEmergencyError(error);
      await failed(failure);
      if (failure === "refused") return NextResponse.json({ error: "refused" }, { status: 400 });
      if (failure === "busy") return NextResponse.json({ error: "busy", retry: true }, { status: 409 });
      if (failure === "unavailable") return NextResponse.json({ error: "unavailable" }, { status: 503 });
      throw error;
    }
  } catch (error) {
    return handleError(error);
  }
}
