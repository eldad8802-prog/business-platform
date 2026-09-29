/**
 * Business Intake M4 · the decision-time identity read.
 *
 * The processor needs identity to CHOOSE a route. This read takes no locks and
 * writes nothing — it is what the evidence says at decision time, recorded as
 * history. A destination that CREATES or LINKS identity (the core Lead
 * destination) resolves again, authoritatively, under the identity locks, in
 * the same transaction as its writes.
 */

import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { Identifier } from "./identifiers";
import { resolveIdentity, type IdentityResult } from "./resolve";

export function preResolveIdentity(businessId: number, identifiers: Identifier[]): Promise<IdentityResult> {
  return withTenantTransaction((tx) => resolveIdentity(tx, businessId, identifiers));
}
