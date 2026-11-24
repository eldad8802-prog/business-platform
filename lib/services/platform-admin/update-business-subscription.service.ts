/**
 * Subscriptions stage B — the platform-admin manual change of a business's subscription. SERVER-ONLY.
 *
 * The ONLY writer of PlatformSubscription / PlatformSubscriptionEvent in this stage. Same shape as the feature-access
 * write path (update-business-feature-access.service.ts):
 *
 *   authorized PLATFORM_ADMIN with a FRESH second factor (route boundary)
 *     → SUBSCRIPTION_ADMIN_CHANGES_ENABLED=true (off by default: nothing can be written until the owner turns it on)
 *       → pure validation (no connection is opened for an invalid request)
 *         → withControlPlaneTransaction(targetBusinessId)   — GUC = the target; RLS confines every statement to it
 *           → read the business and its current row
 *           → one upsert-by-count with an affected-row assertion (never DELETE)
 *           → one PlatformSubscriptionEvent append (ADMIN_CHANGE: from / to, actor, reason)
 *           → one PlatformAuditEvent append
 *         all in ONE transaction: the change, its log row and its audit row commit together or not at all.
 *
 * What an admin may set in this stage — and nothing else:
 *   TESTER   (status EXEMPT, no plan)  — today's access, never a trial, never FREE_LIMITED;
 *   INTERNAL (status EXEMPT, no plan)  — the same, for Dubiz's own accounts;
 *   CUSTOMER + BASIC | ADVANCED (status ACTIVE) — the plan a business is recorded on.
 * PREMIUM is refused while it is not commercially open (decision 4, 2026-11-20). PAST_DUE is never set by hand (stage D).
 * Stage C adds, for a CUSTOMER (status in the request):
 *   TRIALING + trialDays (1–90)  — grant a trial (e.g. a false "duplicate trial" match, decision 28) or extend one:
 *                                  the trial runs from now for trialDays;
 *   FREE_LIMITED                 — end the trial / plan by hand (the limited mode, decisions 6–12).
 *
 * SHADOW: a CUSTOMER row changes no access today — the guard only logs what its plan would refuse
 * (`subscription_would_deny`). The actor is the authenticated admin passed by the route, never read from the body.
 */
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertAffected, withControlPlaneTransaction } from "@/lib/services/control-plane/control-plane-transaction";
import { forgetFeatureGuardBusiness } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_SYSTEM_BUSINESS_NAME } from "@/lib/services/platform-admin/constants";
import { createPlatformAuditEventTx } from "@/lib/services/platform-admin/platform-audit.service";
import {
  PLAN_CATALOG_VERSION,
  PREMIUM_COMMERCIALLY_OPEN,
  isSubscriptionPlan,
  type SubscriptionPlan,
} from "@/lib/services/subscriptions/plan-catalog";
import type { SubscriptionAccountType, SubscriptionStatus } from "@/lib/services/subscriptions/subscription.types";

export const SUBSCRIPTION_ADMIN_CHANGES_ENV = "SUBSCRIPTION_ADMIN_CHANGES_ENABLED";
export const PREMIUM_NOT_OPEN = "PREMIUM_NOT_OPEN";

const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;

export function isSubscriptionAdminChangesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SUBSCRIPTION_ADMIN_CHANGES_ENV] === "true";
}

export type SubscriptionSide = {
  accountType: SubscriptionAccountType;
  status: SubscriptionStatus;
  plan: SubscriptionPlan | null;
  /** Stage C: days of a granted / extended trial (TRIALING only). */
  trialDays?: number;
};

export type SubscriptionChangeRequest = { accountType: unknown; plan: unknown; reason: unknown; status?: unknown; trialDays?: unknown };

export const ADMIN_TRIAL_MAX_DAYS = 90;

/**
 * Pure: validate a request and compute the row it would leave behind. Throws ValidationError / ForbiddenError /
 * ConflictError("NO_CHANGE"). `current` is the existing row's side, or null when the business has no record.
 */
export function planSubscriptionChange(
  current: SubscriptionSide | null,
  request: SubscriptionChangeRequest,
): { target: SubscriptionSide; reason: string } {
  const { accountType, plan } = request;
  if (accountType !== "CUSTOMER" && accountType !== "TESTER" && accountType !== "INTERNAL") {
    throw new ValidationError("Invalid account type");
  }
  if (typeof request.reason !== "string") throw new ValidationError("Reason is required");
  const reason = request.reason.trim();
  if (reason.length < REASON_MIN_LENGTH) throw new ValidationError(`Reason must be at least ${REASON_MIN_LENGTH} characters`);
  if (reason.length > REASON_MAX_LENGTH) throw new ValidationError(`Reason must be at most ${REASON_MAX_LENGTH} characters`);

  let target: SubscriptionSide;
  const status = request.status ?? "ACTIVE";
  if (accountType === "CUSTOMER" && status === "TRIALING") {
    if (plan !== null && plan !== undefined) throw new ValidationError("A trial has no plan");
    const days = request.trialDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > ADMIN_TRIAL_MAX_DAYS) {
      throw new ValidationError(`trialDays must be a whole number between 1 and ${ADMIN_TRIAL_MAX_DAYS}`);
    }
    target = { accountType, status: "TRIALING", plan: null, trialDays: days };
  } else if (accountType === "CUSTOMER" && status === "FREE_LIMITED") {
    if (plan !== null && plan !== undefined) throw new ValidationError("The limited mode has no plan");
    target = { accountType, status: "FREE_LIMITED", plan: null };
  } else if (accountType === "CUSTOMER") {
    if (status !== "ACTIVE") throw new ValidationError("Status must be ACTIVE, TRIALING or FREE_LIMITED");
    if (!isSubscriptionPlan(plan)) throw new ValidationError("A customer needs a plan: BASIC, ADVANCED or PREMIUM");
    if (plan === "PREMIUM" && !PREMIUM_COMMERCIALLY_OPEN) {
      throw new ForbiddenError("Premium is not commercially open yet", PREMIUM_NOT_OPEN);
    }
    target = { accountType, status: "ACTIVE", plan };
  } else {
    if (plan !== null && plan !== undefined) throw new ValidationError("A tester or internal account has no plan");
    target = { accountType, status: "EXEMPT", plan: null };
  }

  // Granting a trial again is an extension, never a no-op.
  if (current && target.status !== "TRIALING" && current.accountType === target.accountType && current.status === target.status && current.plan === target.plan) {
    throw new ConflictError("NO_CHANGE");
  }
  return { target, reason };
}

export type UpdateBusinessSubscriptionInput = {
  actorUserId: number;
  businessId: number;
  request: SubscriptionChangeRequest;
  req?: Request;
};

export type UpdateBusinessSubscriptionResponse = {
  changed: true;
  generatedAt: string;
  business: { id: number; name: string };
  from: SubscriptionSide | null;
  to: SubscriptionSide;
  enforced: false;
};

export async function updateBusinessSubscription(input: UpdateBusinessSubscriptionInput): Promise<UpdateBusinessSubscriptionResponse> {
  // DB-free validation of the request's own shape first; the no-op check needs the current row and runs again inside.
  planSubscriptionChange(null, input.request);

  const result = await withControlPlaneTransaction(input.businessId, async (tx) => {
    const business = await tx.business.findFirst({
      where: { id: input.businessId, name: { not: PLATFORM_SYSTEM_BUSINESS_NAME } },
      select: { id: true, name: true },
    });
    if (!business) throw new NotFoundError("Business not found");

    const row = await tx.platformSubscription.findUnique({
      where: { businessId: input.businessId },
      select: { accountType: true, status: true, plan: true },
    });
    const from: SubscriptionSide | null = row
      ? { accountType: row.accountType as SubscriptionAccountType, status: row.status as SubscriptionStatus, plan: row.plan as SubscriptionPlan | null }
      : null;
    const { target, reason } = planSubscriptionChange(from, input.request);
    const now = new Date();

    const data = {
      accountType: target.accountType,
      status: target.status,
      plan: target.plan,
      catalogVersion: PLAN_CATALOG_VERSION,
      source: "ADMIN",
      updatedByUserId: input.actorUserId,
      // A manual record carries no billing period (stage D). A granted / extended trial runs from now for trialDays.
      trialStartedAt: target.status === "TRIALING" ? now : null,
      trialEndsAt: target.status === "TRIALING" ? new Date(now.getTime() + (target.trialDays ?? 0) * 86_400_000) : null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
    if (row) {
      const updated = await tx.platformSubscription.updateMany({ where: { businessId: input.businessId }, data });
      assertAffected(updated.count, "PlatformSubscription update");
    } else {
      const created = await tx.platformSubscription.createMany({ data: [{ businessId: input.businessId, ...data }] });
      assertAffected(created.count, "PlatformSubscription insert");
    }

    // createMany: no RETURNING — the control plane may append to the log but never read it back.
    const logged = await tx.platformSubscriptionEvent.createMany({
      data: [
        {
          businessId: input.businessId,
          kind: "ADMIN_CHANGE",
          fromAccountType: from?.accountType ?? null,
          toAccountType: target.accountType,
          fromStatus: from?.status ?? null,
          toStatus: target.status,
          fromPlan: from?.plan ?? null,
          toPlan: target.plan,
          actorUserId: input.actorUserId,
          reason,
          catalogVersion: PLAN_CATALOG_VERSION,
        },
      ],
    });
    assertAffected(logged.count, "PlatformSubscriptionEvent insert");

    await createPlatformAuditEventTx(tx, {
      actorUserId: input.actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.SUBSCRIPTION_UPDATED,
      targetType: "BUSINESS",
      targetId: String(input.businessId),
      metadata: { businessId: input.businessId, from, to: target, reason, catalogVersion: PLAN_CATALOG_VERSION, enforced: false },
      req: input.req,
    });

    return { business, from, to: target };
  });

  // This instance re-reads the record on the next guarded request (other instances within their short cache window).
  forgetFeatureGuardBusiness(input.businessId);

  return { changed: true, generatedAt: new Date().toISOString(), ...result, enforced: false };
}
