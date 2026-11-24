/**
 * "מעבר לעוסק מורשה" — the database side (owner decisions 2026-11-20; migration 20261221090000).
 *
 * OFF by default: BUSINESS_KIND_TRANSITION_ENABLED must be exactly "true" (a separate owner approval; not before the
 * accounting effects are handled with the billing track). Every read and the write run in the business's own tenant
 * transaction; `businessId` and `userId` are always the session's, never the request's. The only writer is the
 * definer function, which re-checks everything and writes nothing unless every check passes.
 */

import type { KindTransitionDbStatus, KindTransitionState } from "@/lib/legal-identity/kind-transition";
import { countInterimDocumentsTx, readTransitionWindowTx } from "@/lib/services/billing/kind-transition/interim-documents";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export { isBusinessKindTransitionEnabled } from "@/lib/legal-identity/kind-transition-flag";

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
  /**
   * 4a T4: the number of interim documents the owner saw (issued as an exempt dealer since statusEffectiveDate). The
   * route always sends it. When present, the transition commits only if the same count, taken inside this transaction
   * after the function returned TRANSITIONED, still equals it. Omitted only by direct lab callers (4a's L2 race).
   */
  interimDocumentCount?: number;
};

/**
 * 4a T4 (contract §3.2): the documents changed while the owner was confirming. Thrown INSIDE the tenant transaction so
 * that everything the transition wrote — the profile, the history row, and (when declared) the declaration v2 — rolls
 * back with it; `count` is the number counted in that transaction.
 */
export class InterimDocumentsChangedError extends Error {
  constructor(readonly count: number) {
    super("INTERIM_DOCUMENTS_CHANGED");
    this.name = "InterimDocumentsChangedError";
  }
}

/**
 * Calls the definer function; returns its answer verbatim (the route maps it). After TRANSITIONED, in the same
 * transaction: the function holds the business's legal-identity key exclusively until commit, and every issuance takes
 * the same key shared, so the count below sees every issuance that committed first and none can commit until this
 * transaction ends. Its range is the history row the function just wrote (statusEffectiveDate → confirmedAt).
 */
export async function performKindTransition(businessId: number, userId: number, a: PerformKindTransitionArgs): Promise<KindTransitionDbStatus | string> {
  return tenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<{ r: string }[]>`
      SELECT public.business_kind_transition_to_authorized(
        ${userId}::integer, ${a.vatNumber}, ${a.statusEffectiveDate}::date, ${a.reauthMethod}, ${a.reauthAt}::timestamptz, ${a.statementSha256}) AS r`;
    const r = rows[0]?.r ?? "UNKNOWN";
    if (r !== "TRANSITIONED" || a.interimDocumentCount === undefined) return r;
    const window = await readTransitionWindowTx(tx, businessId);
    if (!window) throw new Error("KIND_TRANSITION_RECORD_NOT_VISIBLE");
    const count = await countInterimDocumentsTx(tx, { businessId, fromDate: window.fromDate, to: window.to });
    if (count !== a.interimDocumentCount) throw new InterimDocumentsChangedError(count);
    return r;
  });
}
