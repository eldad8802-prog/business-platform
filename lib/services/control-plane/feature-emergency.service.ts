/**
 * Leads L1.5-a — the platform EMERGENCY SWITCH for one intake source feature, through the control-plane credential.
 *
 * The whole capability lives in the database function `platform_set_feature_emergency` (migration
 * 20261113090000): the fixed allowlist, the single-column update, the exclusive FG lock taken first and bounded by
 * lock_timeout, and the audit row — all in ONE transaction. The control-plane role holds EXECUTE on that function and
 * no table write at all, so this module can do nothing else. Actor identity, the platform-admin role, a FRESH MFA
 * step-up and the explicit confirmation are the route's job and happen before this is called.
 *
 * No tenant context and no tenant Prisma client: the switch is platform-wide, and the function needs neither.
 */
import { getPrismaControlPlane } from "@/lib/prisma-control-plane";
import { ValidationError } from "@/lib/errors";
import { isIntakeSourceFeature } from "@/lib/intake/acquisition/gate-lock";

export const EMERGENCY_REASON_MIN = 10;
export const EMERGENCY_REASON_MAX = 500;

export type FeatureEmergencyResult = { featureKey: string; wasOn: boolean; isOn: boolean; changed: boolean; auditEventId: number };

/** Why the database refused — mapped by the route to an answer; never a message that could echo input. */
export type FeatureEmergencyFailure = "refused" | "busy" | "unavailable" | "error";

export function classifyEmergencyError(error: unknown): FeatureEmergencyFailure {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  const code = e?.meta?.code ?? e?.code ?? /\b(22023|55P03|42883|42501)\b/.exec(e?.message ?? "")?.[1];
  if (code === "22023") return "refused";
  if (code === "55P03") return "busy";
  // The function is not there yet (migration not applied) or the credential lacks EXECUTE.
  if (code === "42883" || code === "42501") return "unavailable";
  return "error";
}

export function validateEmergencyInput(input: { featureKey: unknown; on: unknown; reason: unknown }): { featureKey: string; on: boolean; reason: string } {
  if (!isIntakeSourceFeature(input.featureKey)) throw new ValidationError("Not an intake source feature");
  if (typeof input.on !== "boolean") throw new ValidationError("on must be true or false");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < EMERGENCY_REASON_MIN || reason.length > EMERGENCY_REASON_MAX) {
    throw new ValidationError(`A reason of ${EMERGENCY_REASON_MIN}–${EMERGENCY_REASON_MAX} characters is required`);
  }
  return { featureKey: input.featureKey, on: input.on, reason };
}

export async function setFeatureEmergency(input: {
  featureKey: unknown;
  on: unknown;
  reason: unknown;
  actorUserId: number;
  ip: string | null;
  userAgent: string | null;
}): Promise<FeatureEmergencyResult> {
  const { featureKey, on, reason } = validateEmergencyInput(input);
  if (!Number.isInteger(input.actorUserId) || input.actorUserId <= 0) throw new ValidationError("An actor is required");
  const rows = await getPrismaControlPlane().$queryRaw<{ was_on: boolean; is_on: boolean; audit_event_id: number }[]>`
    SELECT * FROM public.platform_set_feature_emergency(${featureKey}, ${on}, ${input.actorUserId}::int, ${reason}, ${input.ip}, ${input.userAgent})`;
  const row = rows[0];
  if (!row) throw new Error("emergency switch: the database returned no result");
  return { featureKey, wasOn: row.was_on, isOn: row.is_on, changed: row.was_on !== row.is_on, auditEventId: Number(row.audit_event_id) };
}
