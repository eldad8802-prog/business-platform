/**
 * Knowledge-derive authority — WHO may derive, FOR WHICH business, HOW OFTEN, and the record of it.
 *
 * Everything here happens BEFORE the first derivation write or provider call, in this order, and each
 * refusal leaves ZERO business mutations and ZERO provider calls:
 *
 *   1. AUTHORITY    a DEDICATED machine credential, KNOWLEDGE_DERIVE_SECRET — never the general
 *                   CRON_SECRET (a configuration where they are equal is treated as not configured).
 *                   Constant-time, fail-closed (the settlement-recovery comparison, reused).
 *   2. TARGET       the request's businessId only SELECTS a target. It must be a positive integer.
 *   3. LIFECYCLE    the canonical account-deletion gate: only an ACTIVE business (no deletion request,
 *                   not purged). One definition of "active" — lib/tenant/business-lifecycle.ts.
 *   4. ENROLLMENT   the target must be enrolled: feature `knowledge_derivation` ALLOWED for it through the
 *                   existing, platform-admin-governed feature-access path (default OFF; emergency kill).
 *                   This is the server-authoritative answer to "may this machine act for this tenant".
 *   5. LEASE        one RUNNING run per business (database-enforced), a cooldown between runs, and a
 *                   separate, longer cooldown between Brain (provider) runs. Taken inside the business's
 *                   tenant transaction with the lifecycle ROW LOCK held (no deletion race at the gate).
 *
 * The audit trail is the existing append-only SecurityEvent store: every refused and every executed
 * attempt is one row — codes, counts and versions only; never a secret, prompt, prose or value.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { runWithTenantContext } from "@/lib/tenant/context";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import {
  BusinessQuarantinedError,
  assertBusinessAcceptsWrites,
  assertBusinessAcceptsWritesTx,
} from "@/lib/tenant/business-lifecycle";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";

export const DERIVE_ROUTE = "/api/knowledge/derive";
export const DERIVE_CALLER_CLASS = "derive_workflow";

/** Bounds. Overridable by environment for the lab only; Production uses the defaults. */
export function deriveBounds() {
  const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return {
    /** Minimum seconds between two derivations of the same business. */
    cooldownSeconds: num(process.env.KNOWLEDGE_DERIVE_COOLDOWN_SECONDS, 600),
    /** Minimum seconds between two Brain (provider) runs for the same business. */
    brainCooldownSeconds: num(process.env.KNOWLEDGE_DERIVE_BRAIN_COOLDOWN_SECONDS, 21_600),
    /** A RUNNING run older than this is abandoned (the route's maxDuration is 120s). */
    leaseSeconds: num(process.env.KNOWLEDGE_DERIVE_LEASE_SECONDS, 300),
  };
}

export type DeriveAuthDecision = "AUTHORIZED" | "UNAUTHORIZED" | "NOT_CONFIGURED";

/** The dedicated authority. The general CRON_SECRET can never be it. */
export function decideDeriveAuth(authorizationHeader: string | null | undefined): DeriveAuthDecision {
  const dedicated = (process.env.KNOWLEDGE_DERIVE_SECRET ?? "").trim();
  const general = (process.env.CRON_SECRET ?? "").trim();
  if (dedicated.length > 0 && general.length > 0 && dedicated === general) return "NOT_CONFIGURED";
  return decideRecoveryAuth(authorizationHeader, dedicated);
}

export type GateRefusal =
  | { ok: false; status: 401 | 503; reason: "unauthorized" | "not_configured" }
  | { ok: false; status: 400; reason: "invalid_business" }
  | { ok: false; status: 403; reason: "not_active" | "not_enrolled" }
  | { ok: false; status: 409; reason: "concurrent" }
  | { ok: false; status: 429; reason: "rate_limited" };

export type GateGrant = {
  ok: true;
  businessId: number;
  runId: string;
  brainAllowed: boolean;
  brainSkippedReason: "not_requested" | "cooldown" | null;
};

/** A safe caller correlation reference: a CI run id (digits only) or nothing. */
export function callerRefOf(header: string | null | undefined): string | null {
  const v = (header ?? "").trim();
  return /^[0-9]{1,20}$/.test(v) ? v : null;
}

/** Append one SecurityEvent. INSERT-only for the runtime (no RETURNING: it cannot SELECT the store). */
export async function recordDeriveSecurityEvent(input: {
  outcome: "SUCCESS" | "FAILURE" | "DENIED";
  reasonClass: string | null;
  /** Set only for a business that passed the gate; refusals name no tenant row. */
  businessId: number | null;
  metadata: Record<string, string | number | boolean | null | Record<string, number | string | boolean | null>>;
}): Promise<void> {
  const insert = (db: { $executeRawUnsafe: typeof prisma.$executeRawUnsafe }) =>
    db.$executeRawUnsafe(
      `INSERT INTO "SecurityEvent" ("eventType","outcome","reasonClass","businessId","actorKind","route","metadata")
       VALUES ('KNOWLEDGE_DERIVE', $1, $2, $3, 'SYSTEM', $4, $5::jsonb)`,
      input.outcome, input.reasonClass, input.businessId, DERIVE_ROUTE, JSON.stringify(input.metadata),
    );
  try {
    if (input.businessId != null) await tenantTx(input.businessId, (tx) => insert(tx));
    else await insert(prisma);
  } catch (e) {
    // The audit write must never be the reason a refusal turns into a 500; its failure is itself logged
    // as a code only.
    console.error("[knowledge/derive] security event not recorded", { name: e instanceof Error ? e.name : "unknown" });
  }
}

/**
 * Steps 2–5. `requestedBusinessId` is untrusted input; every refusal returns before any tenant write.
 */
export async function admitDerivation(input: {
  requestedBusinessId: string | null;
  brainRequested: boolean;
  callerRef: string | null;
  now?: Date;
}): Promise<GateGrant | GateRefusal> {
  const businessId = Number(input.requestedBusinessId);
  if (!input.requestedBusinessId || !Number.isInteger(businessId) || businessId <= 0) {
    return { ok: false, status: 400, reason: "invalid_business" };
  }

  // 3. Lifecycle — the canonical gate. Unknown businesses are refused the same way.
  try {
    await assertBusinessAcceptsWrites(businessId);
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return { ok: false, status: 403, reason: "not_active" };
    throw e;
  }

  // 4. Enrollment — the platform-admin-governed feature, resolved in the tenant's own context.
  const access = await runWithTenantContext({ businessId }, () =>
    resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.KNOWLEDGE_DERIVATION));
  if (!access.allowed) return { ok: false, status: 403, reason: "not_enrolled" };

  // 5. Lease — inside the tenant transaction, holding the lifecycle row lock.
  const bounds = deriveBounds();
  const now = input.now ?? new Date();
  const runId = randomUUID();
  try {
    return await tenantTx(businessId, async (tx) => {
      await assertBusinessAcceptsWritesTx(tx, businessId);
      // A crashed run must not wedge the business forever: an expired lease is closed as ABANDONED.
      await tx.knowledgeDerivationRun.updateMany({
        where: { businessId, status: "RUNNING", leaseExpiresAt: { lt: now } },
        data: { status: "ABANDONED", finishedAt: now, failureStage: "lease_expired" },
      });
      const recent = await tx.knowledgeDerivationRun.findFirst({
        where: { businessId, status: { in: ["SUCCEEDED", "FAILED", "RUNNING"] }, startedAt: { gt: new Date(now.getTime() - bounds.cooldownSeconds * 1000) } },
        select: { status: true },
        orderBy: { startedAt: "desc" },
      });
      if (recent?.status === "RUNNING") return { ok: false as const, status: 409 as const, reason: "concurrent" as const };
      if (recent) return { ok: false as const, status: 429 as const, reason: "rate_limited" as const };

      let brainAllowed = false;
      let brainSkippedReason: GateGrant["brainSkippedReason"] = input.brainRequested ? null : "not_requested";
      if (input.brainRequested) {
        const brainRecent = await tx.knowledgeDerivationRun.findFirst({
          where: { businessId, brainInvoked: true, startedAt: { gt: new Date(now.getTime() - bounds.brainCooldownSeconds * 1000) } },
          select: { id: true },
        });
        brainAllowed = brainRecent == null;
        if (!brainAllowed) brainSkippedReason = "cooldown";
      }
      await tx.knowledgeDerivationRun.create({
        data: {
          businessId, runId, callerClass: DERIVE_CALLER_CLASS, callerRef: input.callerRef,
          brainRequested: input.brainRequested, brainAllowed, startedAt: now,
          leaseExpiresAt: new Date(now.getTime() + bounds.leaseSeconds * 1000),
        },
        select: { id: true },
      });
      return { ok: true as const, businessId, runId, brainAllowed, brainSkippedReason };
    });
  } catch (e) {
    // Two admissions racing for the same business: the partial unique index lets exactly one in.
    if ((e as { code?: string })?.code === "P2002") return { ok: false, status: 409, reason: "concurrent" };
    if (e instanceof BusinessQuarantinedError) return { ok: false, status: 403, reason: "not_active" };
    throw e;
  }
}

/** Is the business still ACTIVE? Re-checked before the Brain and before M9 outcome writes. */
export async function stillActive(businessId: number): Promise<boolean> {
  try {
    await assertBusinessAcceptsWrites(businessId);
    return true;
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return false;
    throw e;
  }
}

/** Close the run with its outcome. Counts and codes only. */
export async function finishDerivationRun(businessId: number, runId: string, outcome: {
  status: "SUCCEEDED" | "FAILED";
  failureStage: string | null;
  brainInvoked: boolean;
  counts: Record<string, number>;
  versions: Record<string, string>;
}): Promise<void> {
  await tenantTx(businessId, (tx) =>
    tx.knowledgeDerivationRun.updateMany({
      where: { businessId, runId, status: "RUNNING" },
      data: {
        status: outcome.status, failureStage: outcome.failureStage, brainInvoked: outcome.brainInvoked,
        counts: outcome.counts, versions: outcome.versions, finishedAt: new Date(),
      },
    }));
}
