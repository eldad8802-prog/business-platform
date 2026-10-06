/**
 * Setup after signup — reads and writes, always inside the owner's tenant.
 *
 * Every function takes the business id the caller resolved from the session
 * (getCurrentUser), never one from a request body, and runs in tenantTx so the
 * row-level policies on BusinessProfile and every activity table see the GUC.
 * The answers are written to their canonical homes — category/subCategory/
 * businessModel on BusinessProfile with the same BUSINESS_PROFILE_CHANGED sensor
 * the profile route records — so setup is not a parallel store of facts.
 */

import { recordSensor, changedFields } from "@/lib/sensors/record-sensor";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { isBillingIdentityComplete } from "@/lib/billing/business-identity";

import {
  buildSetupView,
  defaultGoalFor,
  type SetupFacts,
  type SetupGoal,
  type SetupView,
} from "./setup-model";

export type SetupState = SetupView & {
  category: string | null;
  subCategory: string | null;
  businessModel: string | null;
  /** The stored goal exactly as recorded (null until setup completes). */
  storedGoal: string | null;
};

const PROFILE_SELECT = {
  category: true,
  subCategory: true,
  businessModel: true,
  onboardingCompletedAt: true,
  onboardingGoal: true,
  onboardingGoalSource: true,
  billingLegalName: true,
  billingBusinessKind: true,
  billingTaxId: true,
  billingAddress: true,
  billingPhone: true,
  billingEmail: true,
} as const;

export async function loadSetupState(businessId: number): Promise<SetupState> {
  return tenantTx(businessId, async (tx) => {
    // Existence, not volume: each probe stops at the first row.
    const [profile, lead, billingDoc, doc, run, wa] = await Promise.all([
      tx.businessProfile.findUnique({ where: { businessId }, select: PROFILE_SELECT }),
      tx.lead.findFirst({ where: { businessId }, select: { id: true } }),
      tx.billingDocument.findFirst({ where: { businessId }, select: { id: true } }),
      tx.document.findFirst({ where: { businessId }, select: { id: true } }),
      tx.contentRun.findFirst({ where: { businessId }, select: { id: true } }),
      tx.whatsAppConnection.findUnique({ where: { businessId }, select: { status: true } }),
    ]);

    const facts: SetupFacts = {
      onboardingCompletedAt: profile?.onboardingCompletedAt ?? null,
      onboardingGoal: profile?.onboardingGoal ?? null,
      onboardingGoalSource: profile?.onboardingGoalSource ?? null,
      category: profile?.category ?? null,
      businessModel: profile?.businessModel ?? null,
      billingIdentityComplete: isBillingIdentityComplete(profile),
      whatsappConnected: wa?.status === "CONNECTED",
      counts: {
        leads: lead ? 1 : 0,
        billingDocuments: billingDoc ? 1 : 0,
        documents: doc ? 1 : 0,
        contentRuns: run ? 1 : 0,
      },
    };

    return {
      ...buildSetupView(facts),
      category: profile?.category ?? null,
      subCategory: profile?.subCategory ?? null,
      businessModel: profile?.businessModel ?? null,
      storedGoal: profile?.onboardingGoal ?? null,
    };
  });
}

/** "What does the business do" — the owner's own answer, already validated. */
export async function saveBusinessAnswer(
  actor: { businessId: number; userId: number },
  answer: { category: string; subCategory: string; businessModel: string }
): Promise<void> {
  const { businessId, userId } = actor;
  await tenantTx(businessId, async (tx) => {
    const before = await tx.businessProfile.findUnique({
      where: { businessId },
      select: { category: true, subCategory: true, businessModel: true },
    });
    const saved = await tx.businessProfile.upsert({
      where: { businessId },
      update: answer,
      create: { businessId, ...answer },
      select: { category: true, subCategory: true, businessModel: true },
    });
    const prev = {
      category: before?.category ?? null,
      subCategory: before?.subCategory ?? null,
      businessModel: before?.businessModel ?? null,
    };
    const next = {
      category: saved.category ?? null,
      subCategory: saved.subCategory ?? null,
      businessModel: saved.businessModel ?? null,
    };
    const fields = changedFields(prev, next, ["category", "subCategory", "businessModel"]);
    if (fields.length > 0) {
      await recordSensor(
        {
          businessId,
          sensor: "BUSINESS_PROFILE_CHANGED",
          entityId: businessId,
          actor: { type: "OWNER_USER", userId },
          source: "OWNER_UI",
          payload: {
            fields,
            ...(fields.includes("businessModel")
              ? { fromBusinessModel: prev.businessModel, toBusinessModel: next.businessModel }
              : {}),
          },
        },
        { tx }
      );
    }
  });
}

/**
 * Finish setup. `goal` null means the owner skipped: a default is derived from
 * what they said about the business and stored as DEFAULTED, so it can never be
 * read back as their choice. Re-running only moves the goal; the completion
 * stamp keeps the first moment setup was finished.
 */
export async function completeSetup(businessId: number, goal: SetupGoal | null): Promise<void> {
  await tenantTx(businessId, async (tx) => {
    const current = await tx.businessProfile.findUnique({
      where: { businessId },
      select: { businessModel: true, onboardingCompletedAt: true },
    });
    const chosen = goal ?? defaultGoalFor(current?.businessModel);
    const data = {
      onboardingGoal: chosen,
      onboardingGoalSource: goal ? "OWNER_SELECTED" : "DEFAULTED",
      onboardingCompletedAt: current?.onboardingCompletedAt ?? new Date(),
    };
    await tx.businessProfile.upsert({
      where: { businessId },
      update: data,
      create: { businessId, ...data },
      select: { id: true },
    });
  });
}

/**
 * Rename the owner's business. The runtime holds UPDATE on Business.name only,
 * and B4's business_tenant_write policy admits the row only when it is the
 * business tenantTx named — another tenant's row is invisible to the update.
 */
export async function renameBusiness(businessId: number, name: string): Promise<{ name: string }> {
  return tenantTx(businessId, async (tx) => {
    const updated = await tx.business.updateMany({ where: { id: businessId }, data: { name } });
    if (updated.count !== 1) throw new Error("rename_not_applied");
    return { name };
  });
}
