/**
 * Production dependency wiring for the obligations services.
 *
 * Routes call the services with `obligationServiceDeps()` and never reach for
 * Prisma directly — mirroring the payments domain DI pattern.
 */

import { createObligationPrismaStore } from "./obligation-store.prisma";
import type { ObligationServiceDeps } from "./obligation.service";

export function obligationServiceDeps(): ObligationServiceDeps {
  return {
    store: createObligationPrismaStore(),
  };
}
