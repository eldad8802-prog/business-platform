/**
 * Activity packs — the business's choice, read and written inside its own tenant.
 *
 * Every function takes the business id the caller resolved from the session (getCurrentUser), never one from a
 * request body, and runs in tenantTx so the row-level policies see the tenant. The table holds at most one row per
 * business (BusinessActivityProfile, migration 20261216090000); no row = the owner never chose.
 *
 * Display only: nothing here reads or changes feature access, a plan, billing or permissions.
 */

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { selectionFromRow, type ActivitySelection } from "@/lib/activity-packs/activity-packs";

export async function loadActivitySelection(businessId: number): Promise<ActivitySelection | null> {
  return tenantTx(businessId, async (tx) => {
    const row = await tx.businessActivityProfile.findUnique({
      where: { businessId },
      select: { primaryPack: true, additionalPacks: true },
    });
    return selectionFromRow(row);
  });
}

/** Replace the business's choice (insert on first save). The selection is already validated by the caller. */
export async function saveActivitySelection(businessId: number, userId: number, selection: ActivitySelection): Promise<ActivitySelection> {
  return tenantTx(businessId, async (tx) => {
    const data = { primaryPack: selection.primary, additionalPacks: [...selection.additional], updatedByUserId: userId };
    const row = await tx.businessActivityProfile.upsert({
      where: { businessId },
      create: { businessId, source: "OWNER_SELECTED", ...data },
      update: data,
      select: { primaryPack: true, additionalPacks: true },
    });
    const saved = selectionFromRow(row);
    if (!saved) throw new Error("ACTIVITY_PACKS_SAVE_UNREADABLE");
    return saved;
  });
}
