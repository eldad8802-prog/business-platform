import {
  PartyClaimStatus,
  PartyRoleType,
  Prisma,
} from "@prisma/client";
import {
  extractStrongSignals,
  resolvePartyForRoleRowTx,
  type ResolvePartyForRoleRowTxResult,
} from "@/lib/services/party/party-resolution.service";

/**
 * Supplier Domain Phase 1 — Supplier as Party Role.
 *
 * Thin, supplier-specific adapter over the generic Party resolver. It introduces
 * NO new resolution logic: candidate lookup, the signal-conflict fail-safe,
 * anchors, and idempotency all live in `resolvePartyForRoleRowTx`. This file only
 * maps a Supplier row onto the generic `subjectType=SUPPLIER` role-row, using
 * STRONG signals only.
 *
 *   taxId → KNOWN · phone → BELIEVED · no strong signal → SELF_ANCHOR/UNKNOWN
 *
 * `name` (display / Supporting) and `email` (contact / corroboration) are NEVER
 * signals — they are excluded by construction (the generic reads only phone+taxId).
 */

export const SUPPLIER_PARTY_SOURCE_CREATE = "supplier:create";
export const SUPPLIER_PARTY_SOURCE_UPDATE = "supplier:update";

export type SupplierPartyInput = {
  businessId: number;
  supplierId: number;
  taxId?: string | null;
  phone?: string | null;
  source?: string;
  resolvedByUserId?: number | null;
};

/** Resolve a Supplier row to its Party via the generic resolver (create path). */
export function resolveSupplierPartyTx(
  tx: Prisma.TransactionClient,
  input: SupplierPartyInput
): Promise<ResolvePartyForRoleRowTxResult> {
  return resolvePartyForRoleRowTx(tx, {
    businessId: input.businessId,
    subjectType: PartyRoleType.SUPPLIER,
    subjectId: input.supplierId,
    // ONLY strong signals reach resolution. `extractStrongSignals` reads
    // phone + taxId; name/email are structurally impossible to feed as signals.
    signals: { phone: input.phone ?? null, taxId: input.taxId ?? null },
    source: input.source ?? SUPPLIER_PARTY_SOURCE_CREATE,
    resolvedByUserId: input.resolvedByUserId ?? null,
  });
}

/**
 * Re-resolution for a Supplier whose strong signals (taxId / phone) may have
 * changed. Corrigible by construction — claims are RETRACTED, never deleted:
 *
 *   1. RETRACT active PHONE/TAX_ID claims whose stored value no longer matches
 *      the supplier's current normalized signal (changed or removed).
 *   2. RETRACT an active no-signal anchor claim once the supplier carries a real
 *      strong signal — the anchor was a pre-signal placeholder, and keeping it
 *      would pin the subject to its isolated Party and block legitimate
 *      convergence (e.g. a Supplier that shares a taxId with a Customer).
 *   3. Re-resolve from the current signals (the generic re-creates fresh claims
 *      or a new anchor). Idempotent when nothing actually changed.
 *
 * Phase 1 is identity-only. Genuine cross-party conflicts (two distinct strong
 * signals disagreeing) surface via the generic's fail-safe and roll back the
 * enclosing transaction — never a silent merge.
 */
export async function reResolveSupplierPartyTx(
  tx: Prisma.TransactionClient,
  input: SupplierPartyInput
): Promise<ResolvePartyForRoleRowTxResult> {
  const strong = extractStrongSignals({
    phone: input.phone ?? null,
    taxId: input.taxId ?? null,
  });
  const hasStrongSignal = Boolean(strong.taxId || strong.phone);

  const activeClaims = await tx.partyResolutionClaim.findMany({
    where: {
      businessId: input.businessId,
      subjectType: PartyRoleType.SUPPLIER,
      subjectId: input.supplierId,
      status: PartyClaimStatus.ACTIVE,
    },
    select: { id: true, signalType: true, signalValue: true },
  });

  const staleClaimIds = activeClaims
    .filter((claim) => {
      if (claim.signalType === null) {
        // Anchor: superseded once a real strong signal exists.
        return hasStrongSignal;
      }
      const current =
        claim.signalType === "TAX_ID" ? strong.taxId : strong.phone;
      return claim.signalValue !== current; // null current === signal removed
    })
    .map((claim) => claim.id);

  if (staleClaimIds.length > 0) {
    await tx.partyResolutionClaim.updateMany({
      where: { id: { in: staleClaimIds } },
      data: { status: PartyClaimStatus.RETRACTED },
    });
  }

  return resolveSupplierPartyTx(tx, {
    ...input,
    source: input.source ?? SUPPLIER_PARTY_SOURCE_UPDATE,
  });
}
