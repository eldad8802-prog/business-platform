/**
 * "מעבר לעוסק מורשה" — the database side (owner decisions 2026-11-20; migration 20261221090000).
 *
 * OFF by default: BUSINESS_KIND_TRANSITION_ENABLED must be exactly "true" (a separate owner approval; not before the
 * accounting effects are handled with the billing track). Every read and the write run in the business's own tenant
 * transaction; `businessId` and `userId` are always the session's, never the request's. The only writer is the
 * definer function, which re-checks everything and writes nothing unless every check passes.
 */

import type { KindTransitionDbStatus, KindTransitionState } from "@/lib/legal-identity/kind-transition";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export function isBusinessKindTransitionEnabled(): boolean {
  return process.env.BUSINESS_KIND_TRANSITION_ENABLED === "true";
}

export type KindTransitionHistory = {
  fromKind: string;
  toKind: string;
  statusEffectiveDate: string;
  confirmedAt: string;
  reauthMethod: string;
};

export type KindTransitionSnapshot = { state: KindTransitionState; history: KindTransitionHistory | null };

export async function readKindTransitionSnapshot(businessId: number, userId: number): Promise<KindTransitionSnapshot> {
  return tenantTx(businessId, async (tx) => {
    const [profile, business, users, declaration, history] = await Promise.all([
      tx.businessProfile.findUnique({
        where: { businessId },
        select: { billingBusinessKind: true, billingLegalName: true, billingTaxId: true, billingVatNumber: true },
      }),
      tx.business.findUnique({ where: { id: businessId }, select: { deletionRequestedAt: true, deletedAt: true } }),
      tx.user.findMany({ where: { businessId }, select: { id: true } }),
      tx.businessIssuerDeclaration.findFirst({ where: { businessId }, orderBy: { version: "desc" }, select: { anonymisedAt: true } }),
      tx.businessKindTransition.findUnique({
        where: { businessId },
        select: { fromKind: true, toKind: true, statusEffectiveDate: true, confirmedAt: true, reauthMethod: true },
      }),
    ]);
    return {
      state: {
        billingBusinessKind: profile?.billingBusinessKind ?? null,
        billingLegalName: profile?.billingLegalName ?? null,
        billingTaxId: profile?.billingTaxId ?? null,
        billingVatNumber: profile?.billingVatNumber ?? null,
        businessBeingDeleted: !business || business.deletionRequestedAt !== null || business.deletedAt !== null,
        actorIsSoleUser: users.length === 1 && users[0].id === userId,
        hasLiveIssuerDeclaration: declaration !== null && declaration.anonymisedAt === null,
      },
      history: history
        ? {
            fromKind: history.fromKind,
            toKind: history.toKind,
            statusEffectiveDate: history.statusEffectiveDate.toISOString().slice(0, 10),
            confirmedAt: history.confirmedAt.toISOString(),
            reauthMethod: history.reauthMethod,
          }
        : null,
    };
  });
}

export type PerformKindTransitionArgs = {
  vatNumber: string;
  statusEffectiveDate: string;
  reauthMethod: "PASSWORD" | "GOOGLE";
  reauthAt: Date;
  statementSha256: string;
};

/** Calls the definer function; returns its answer verbatim (the route maps it). */
export async function performKindTransition(businessId: number, userId: number, a: PerformKindTransitionArgs): Promise<KindTransitionDbStatus | string> {
  return tenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<{ r: string }[]>`
      SELECT public.business_kind_transition_to_authorized(
        ${userId}::integer, ${a.vatNumber}, ${a.statusEffectiveDate}::date, ${a.reauthMethod}, ${a.reauthAt}::timestamptz, ${a.statementSha256}) AS r`;
    return rows[0]?.r ?? "UNKNOWN";
  });
}
