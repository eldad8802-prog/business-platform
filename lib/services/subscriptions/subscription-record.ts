/**
 * Subscriptions stage B — read the business's PlatformSubscription row. SERVER-ONLY. TENANT path.
 *
 * Runs in a tenant transaction for the business itself (FORCE RLS: the runtime role sees only its own row and can
 * change nothing). The business id comes from the trusted server side (session, or a background step that already
 * knows its business) — it is never a request input.
 *
 * A row whose values the code does not recognise is refused loudly (throws) rather than guessed: the caller
 * (loadSubscriptionSnapshot) logs it and degrades to "no record", which is today's access. In shadow that is the only
 * safe direction; stage C, which enforces, must decide fail-closed handling explicitly.
 */
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

import { isSubscriptionPlan } from "./plan-catalog";
import {
  SUBSCRIPTION_ACCOUNT_TYPES,
  SUBSCRIPTION_STATUSES,
  type SubscriptionAccountType,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
} from "./subscription.types";

export class SubscriptionRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionRecordError";
  }
}

type Row = { accountType: string; status: string; plan: string | null; catalogVersion: string; trialEndsAt?: Date | null };

/** Pure: a database row → the snapshot the resolver reads. Throws on any value outside the known sets. */
export function subscriptionSnapshotFromRow(row: Row): SubscriptionSnapshot {
  if (!(SUBSCRIPTION_ACCOUNT_TYPES as readonly string[]).includes(row.accountType)) {
    throw new SubscriptionRecordError("unknown account type");
  }
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(row.status)) {
    throw new SubscriptionRecordError("unknown status");
  }
  if (row.plan !== null && !isSubscriptionPlan(row.plan)) {
    throw new SubscriptionRecordError("unknown plan");
  }
  return {
    accountType: row.accountType as SubscriptionAccountType,
    status: row.status as SubscriptionStatus,
    plan: row.plan,
    catalogVersion: row.catalogVersion,
    trialEndsAt: row.trialEndsAt ?? null,
  };
}

export async function readSubscriptionRecord(businessId: number): Promise<SubscriptionSnapshot | null> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const row = await tx.platformSubscription.findUnique({
        where: { businessId },
        select: { accountType: true, status: true, plan: true, catalogVersion: true, trialEndsAt: true },
      });
      return row ? subscriptionSnapshotFromRow(row) : null;
    }),
  );
}
