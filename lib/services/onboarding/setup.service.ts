/**
 * Setup after signup — reads and writes, always inside the owner's tenant.
 *
 * Every function takes the business id the caller resolved from the session
 * (getCurrentUser), never one from a request body, and runs in tenantTx so the
 * row-level policies see the GUC.
 *
 * The answers are written to their canonical home through the one writer of
 * owner identity (identity-statement.service): DESCRIPTION text and
 * TARGET_AUDIENCE codes, source OWNER_INPUT, sourceRef "setup". Setup is not a
 * parallel store of facts, and it never writes a category, a goal or a first
 * action. The legacy onboardingGoal columns are left untouched (no reader).
 */

import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  createIdentityStatement,
  retireIdentityStatement,
} from "@/lib/services/identity/identity-statement.service";

import {
  SETUP_AUDIENCE_CODES,
  buildSetupView,
  codesForAudience,
  type AboutAnswer,
  type SetupView,
} from "./setup-model";

const SETUP_SOURCE_REF = "setup";

export async function loadSetupState(businessId: number): Promise<SetupView> {
  return tenantTx(businessId, async (tx) => {
    const [profile, statements] = await Promise.all([
      tx.businessProfile.findUnique({ where: { businessId }, select: { onboardingCompletedAt: true } }),
      tx.businessIdentityStatement.findMany({
        where: {
          businessId,
          status: "ACTIVE",
          OR: [
            { dimension: "DESCRIPTION" },
            { dimension: "TARGET_AUDIENCE", code: { in: [...SETUP_AUDIENCE_CODES] } },
          ],
        },
        select: { dimension: true, code: true, text: true },
      }),
    ]);
    const description = statements.find((s) => s.dimension === "DESCRIPTION")?.text ?? null;
    const audienceCodes = statements
      .filter((s) => s.dimension === "TARGET_AUDIENCE" && s.code)
      .map((s) => s.code as string);
    return buildSetupView({
      onboardingCompletedAt: profile?.onboardingCompletedAt ?? null,
      description,
      audienceCodes,
    });
  });
}

/**
 * Save what the owner said so far. A description replaces the previous one
 * (the identity writer retires it); an audience answer sets exactly the
 * INDIVIDUALS / BUSINESSES statements it means and leaves every other
 * TARGET_AUDIENCE code alone.
 */
export async function saveAbout(actor: { businessId: number; userId: number }, answer: AboutAnswer): Promise<void> {
  const { businessId, userId } = actor;
  if (answer.description === undefined && answer.audience === undefined) return;
  await tenantTx(businessId, async (tx) => {
    if (answer.description !== undefined) {
      await createIdentityStatement(
        {
          businessId,
          userId,
          dimension: "DESCRIPTION",
          text: answer.description,
          source: "OWNER_INPUT",
          sourceRef: SETUP_SOURCE_REF,
        },
        tx
      );
    }
    if (answer.audience !== undefined) {
      const wanted = new Set<string>(codesForAudience(answer.audience));
      const active = await tx.businessIdentityStatement.findMany({
        where: { businessId, status: "ACTIVE", dimension: "TARGET_AUDIENCE", code: { in: [...SETUP_AUDIENCE_CODES] } },
        select: { id: true, code: true },
      });
      // Retire first, so a switch (e.g. BUSINESSES → INDIVIDUALS) never trips the active cap.
      for (const row of active) {
        if (!row.code || !wanted.has(row.code)) {
          await retireIdentityStatement({ businessId, userId, statementId: row.id }, tx);
        }
      }
      const have = new Set(active.map((r) => r.code));
      for (const code of wanted) {
        if (have.has(code)) continue;
        await createIdentityStatement(
          {
            businessId,
            userId,
            dimension: "TARGET_AUDIENCE",
            code,
            source: "OWNER_INPUT",
            sourceRef: SETUP_SOURCE_REF,
          },
          tx
        );
      }
    }
  });
}

/**
 * Finish (or skip) the screen. Only the completion stamp is written, once;
 * re-running keeps the first moment setup was finished.
 */
export async function completeSetup(businessId: number): Promise<void> {
  await tenantTx(businessId, async (tx) => {
    const current = await tx.businessProfile.findUnique({
      where: { businessId },
      select: { onboardingCompletedAt: true },
    });
    if (current?.onboardingCompletedAt) return;
    const data = { onboardingCompletedAt: new Date() };
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
