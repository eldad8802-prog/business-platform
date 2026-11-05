/**
 * Leads L1.5-a — the platform EMERGENCY SWITCH for the seven intake sources.
 *
 *   GET   the seven states (admin read client)                                   platform admin
 *   POST  { featureKey, on, reason, confirm }                                     platform admin + FRESH MFA (≤ 5 min)
 *         confirm must repeat the featureKey exactly (an explicit, typed confirmation)
 *
 * Order (CI-pinned): identity → fresh step-up → the mutation kill-switch (FEATURE_ACCESS_MUTATIONS_ENABLED) → body
 * validation → an "attempted" audit row → the control-plane function (change + its own audit row, one transaction,
 * FG lock first) → on any failure a "failed" audit row. Answers:
 *   200 applied (or already in that state — audited as unchanged)   400 invalid / refused by the database
 *   409 busy (the FG lock was not free within 5 s — nothing changed) 503 switch unavailable (migration not applied)
 */
import { NextRequest, NextResponse } from "next/server";
import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/security/rate-limit";
import { isFeatureAccessMutationsEnabled } from "@/lib/services/feature-access/feature-access-mutations";
import { auditEmergencyAttempt, getIntakeEmergencyStates } from "@/lib/services/platform-admin/intake-emergency.service";
import { classifyEmergencyError, setFeatureEmergency, validateEmergencyInput } from "@/lib/services/control-plane/feature-emergency.service";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json({ features: await getIntakeEmergencyStates() }, { status: 200 });
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

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const input = validateEmergencyInput({ featureKey: body?.featureKey, on: body?.on, reason: body?.reason });
    if (body?.confirm !== input.featureKey) throw new ValidationError("Type the feature key to confirm");

    const ip = getClientIp(req);
    const userAgent = req.headers.get("user-agent");
    await auditEmergencyAttempt({ actorUserId: auth.id, featureKey: input.featureKey, outcome: "attempted", on: input.on, ip, userAgent });
    try {
      const result = await setFeatureEmergency({ ...input, actorUserId: auth.id, ip, userAgent });
      return NextResponse.json({ result }, { status: 200 });
    } catch (error) {
      const failure = classifyEmergencyError(error);
      await auditEmergencyAttempt({ actorUserId: auth.id, featureKey: input.featureKey, outcome: "failed", on: input.on, failure, ip, userAgent })
        .catch(() => undefined);
      if (failure === "refused") return NextResponse.json({ error: "refused" }, { status: 400 });
      if (failure === "busy") return NextResponse.json({ error: "busy", retry: true }, { status: 409 });
      if (failure === "unavailable") return NextResponse.json({ error: "unavailable" }, { status: 503 });
      throw error;
    }
  } catch (error) {
    return handleError(error);
  }
}
