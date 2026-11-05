/**
 * Leads L1.5-a — the platform-admin READ of the emergency switch for the seven intake sources (the admin read client,
 * SELECT only), and the audit of every ATTEMPT to change it.
 *
 * The change itself goes through the control-plane function (lib/services/control-plane/feature-emergency.service.ts),
 * which writes its own audit row in the same transaction as the change. What it cannot audit is an attempt that never
 * reached it or that it refused (its transaction rolls back, audit included) — those are appended here, through the
 * admin client's append-only PlatformAuditEvent privilege, so EVERY try leaves a row: attempted, then applied or failed.
 */
import { getPrismaAdmin } from "@/lib/prisma-admin";
import { INTAKE_SOURCE_FEATURES } from "@/lib/intake/acquisition/gate-lock";
import { PLATFORM_AUDIT_ACTIONS } from "./constants";

export type IntakeEmergencyState = {
  featureKey: string;
  displayName: string;
  emergencyOn: boolean;
  globalEnabled: boolean;
  updatedAt: string | null;
  updatedByUserId: number | null;
};

export async function getIntakeEmergencyStates(): Promise<IntakeEmergencyState[]> {
  const db = getPrismaAdmin();
  const keys = [...INTAKE_SOURCE_FEATURES];
  const [policies, definitions] = await Promise.all([
    db.platformFeaturePolicy.findMany({ where: { featureKey: { in: keys } } }),
    db.platformFeatureDefinition.findMany({ where: { key: { in: keys } }, select: { key: true, displayName: true } }),
  ]);
  const byKey = new Map(policies.map((p) => [p.featureKey, p]));
  const names = new Map(definitions.map((d) => [d.key, d.displayName]));
  return keys.map((featureKey) => {
    const p = byKey.get(featureKey);
    return {
      featureKey,
      displayName: names.get(featureKey) ?? featureKey,
      emergencyOn: p?.emergencyDisabled ?? false,
      globalEnabled: p?.globalEnabled ?? false,
      updatedAt: p?.updatedAt ? p.updatedAt.toISOString() : null,
      updatedByUserId: p?.updatedByUserId ?? null,
    };
  });
}

/** Append-only: one row per attempt and one per failure. Counts and codes only — never the request body. */
export async function auditEmergencyAttempt(input: {
  actorUserId: number;
  featureKey: string;
  outcome: "attempted" | "failed";
  on: boolean | null;
  failure?: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  await getPrismaAdmin().platformAuditEvent.createMany({
    data: {
      actorUserId: input.actorUserId,
      action: input.outcome === "attempted" ? PLATFORM_AUDIT_ACTIONS.FEATURE_EMERGENCY_ATTEMPTED : PLATFORM_AUDIT_ACTIONS.FEATURE_EMERGENCY_FAILED,
      targetType: "PlatformFeature",
      targetId: input.featureKey.slice(0, 64),
      metadata: { on: input.on, ...(input.failure ? { failure: input.failure } : {}) },
      ip: input.ip,
      userAgent: input.userAgent ? input.userAgent.slice(0, 256) : null,
    },
  });
}
