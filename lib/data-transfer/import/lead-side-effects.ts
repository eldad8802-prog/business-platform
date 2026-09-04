/**
 * What importing Leads ALSO creates, counted before the owner confirms.
 *
 * `leadService.createLead` resolves-or-creates a `Customer` for the lead's
 * phone. That is canonical, architectural behaviour — Lead sits above Customer
 * and never replaces it — and the owner's decision was to keep it exactly as it
 * is rather than route imports around it.
 *
 * What was missing is disclosure. Importing 300 leads can create up to 300
 * customers, and an owner who is not told that will discover it afterwards in a
 * screen they did not expect to change. So this projects the side effect using
 * the SAME rule the service applies, and the preview shows the number.
 *
 * A projection, not a promise: it is computed as a read at preview time, and
 * another process may add a matching customer in between. The reconciliation is
 * that the service itself re-resolves inside the write transaction — so the
 * real outcome can only be BETTER than projected (one more reuse, one fewer
 * creation), never a surprise extra record.
 *
 * Read-only. No writes anywhere in this file.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { ValidatedRow } from "@/lib/data-transfer/import/validate/row-validate";

export type LeadSideEffects = {
  /** Leads whose phone already has a customer — that record is reused. */
  reusedCustomers: number;
  /**
   * Leads that will cause a NEW customer record.
   *
   * Includes leads with no phone at all: with no identity to match on, the
   * service creates a fresh contact, and two same-named walk-ins genuinely are
   * two contacts.
   */
  newCustomers: number;
};

/**
 * Project the customer side effect for the lead rows that will actually run.
 *
 * Only rows the owner is importing are counted — a SKIPPED row creates nothing,
 * and counting it would overstate the consequence of confirming.
 */
export async function projectLeadSideEffects(
  businessId: number,
  rows: readonly ValidatedRow[]
): Promise<LeadSideEffects> {
  if (rows.length === 0) return { reusedCustomers: 0, newCustomers: 0 };

  const phones = rows.map((row) => {
    const value = row.canonical["טלפון"];
    return typeof value === "string" && value.length > 0 ? value : null;
  });

  const distinct = [...new Set(phones.filter((p): p is string => p !== null))];
  const existing = new Set<string>();

  if (distinct.length > 0) {
    await runWithTenantContext({ businessId }, () =>
      withTenantTransaction(async (tx) => {
        const found = await tx.customer.findMany({
          where: { businessId, phone: { in: distinct } },
          select: { phone: true },
        });
        for (const customer of found) {
          if (customer.phone) existing.add(customer.phone);
        }
      })
    );
  }

  let reusedCustomers = 0;
  let newCustomers = 0;
  // Two rows in the same file sharing a phone would resolve to ONE customer:
  // the first creates it, the second reuses it. Tracked here so the projection
  // matches what the service will actually do.
  const createdInThisRun = new Set<string>();

  for (const phone of phones) {
    if (phone === null) {
      newCustomers += 1;
      continue;
    }
    if (existing.has(phone) || createdInThisRun.has(phone)) {
      reusedCustomers += 1;
      continue;
    }
    createdInThisRun.add(phone);
    newCustomers += 1;
  }

  return { reusedCustomers, newCustomers };
}
