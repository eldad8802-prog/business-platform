/**
 * Production dependency wiring for the obligations services.
 *
 * Routes call the services with `obligationServiceDeps()` and never reach for
 * Prisma directly — mirroring the payments domain DI pattern.
 */

import { createObligationPrismaStore } from "./obligation-store.prisma";
import type { ObligationServiceDeps } from "./obligation.service";
import type { TenantTx } from "@/lib/tenant/transaction";

/**
 * D2/P7 Wave 1: routes wrap the service call in
 * runWithTenantContext -> withTenantTransaction and pass the transaction here,
 * binding the store to the GUC-carrying connection (RLS defense-in-depth).
 * Without options the store binds to the canonical singleton as before.
 */
export function obligationServiceDeps(options?: {
  tx?: TenantTx;
}): ObligationServiceDeps {
  return {
    store: createObligationPrismaStore(options?.tx),
  };
}
