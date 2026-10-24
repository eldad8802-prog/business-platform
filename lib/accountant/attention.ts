/**
 * The monthly accountant workflow in the Attention snapshot (/attention and the Home status slot).
 *
 * The items are the SAME facts and words as the notifications (translatePeriodNotice) — one surface
 * never contradicts the other. Months the owner still has to act on, newest first, at most three.
 * Works whether Daily Tasks is on or off.
 *
 * Fail-open by design: the Attention snapshot is the owner's morning screen, and a business without
 * the feature, a flag lookup error or a missing table (code deployed before its migration) all yield
 * no items rather than a broken screen.
 */

import type { BusinessStatusItemBuild } from "@/lib/business-status/types";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { accountantWorkflowEnabled } from "./http";
import { noticeKindFor, translatePeriodNotice } from "./notify";
import { parseStoredReadiness } from "./store";
import { OWNER_ACTION_STATUSES, type PeriodStatus } from "./workflow-status";

export const ATTENTION_MAX_PERIODS = 3;

export async function loadAccountantAttention(businessId: number, now: Date): Promise<BusinessStatusItemBuild[]> {
  try {
    if (!(await accountantWorkflowEnabled(businessId))) return [];
    const rows = await tenantTx(businessId, (tx) =>
      tx.accountantPeriod.findMany({
        where: {
          businessId,
          OR: [{ status: { in: [...OWNER_ACTION_STATUSES] } }, { changedSinceSent: true, status: { in: ["SENT", "COMPLETED_MANUALLY"] } }],
        },
        orderBy: { periodKey: "desc" },
        take: ATTENTION_MAX_PERIODS,
      })
    );
    const items: BusinessStatusItemBuild[] = [];
    for (const p of rows) {
      const status = p.status as PeriodStatus;
      const kind = noticeKindFor({ status, changedSinceSent: p.changedSinceSent });
      if (!kind) continue;
      items.push(
        translatePeriodNotice(
          {
            businessId,
            periodId: p.id,
            periodKey: p.periodKey,
            status,
            changedSinceSent: p.changedSinceSent,
            readiness: parseStoredReadiness(p.readiness),
          },
          kind,
          // Priority follows the month's own age, so an older open month ranks above a fresh one.
          p.notifiedAt ?? p.evaluatedAt ?? now
        )
      );
    }
    return items;
  } catch {
    return [];
  }
}
