/**
 * Production dependency wiring for the obligations services.
 *
 * Routes call the services with `obligationServiceDeps()` and never reach for
 * Prisma directly — mirroring the payments domain DI pattern.
 */

import { createObligationPrismaStore } from "./obligation-store.prisma";
import type { ObligationChange, ObligationServiceDeps } from "./obligation.service";
import type { TenantTx } from "@/lib/tenant/transaction";
import { recordSensor } from "@/lib/sensors/record-sensor";
import type { SensorActor, SensorSource } from "@/lib/sensors/sensor.contract";

/**
 * D2/P7 Wave 1: routes wrap the service call in
 * runWithTenantContext -> withTenantTransaction and pass the transaction here,
 * binding the store to the GUC-carrying connection (RLS defense-in-depth).
 * Without options the store binds to the canonical singleton as before.
 *
 * M5.5: `actorUserId` is the SESSION user's id, threaded from the route. It binds the
 * OBLIGATION_CHANGED sensor to that person (OWNER_USER / OWNER_UI). Without it the sensor records
 * the actor as UNKNOWN rather than guessing. Steps Dubiz takes on its own (the next recurring
 * instance) are SYSTEM / SYSTEM regardless. Inside `tx` the event is written atomically with the
 * change; without `tx` it is written after, fail-open.
 */
export function obligationServiceDeps(options?: {
  tx?: TenantTx;
  actorUserId?: number;
}): ObligationServiceDeps {
  const tx = options?.tx;
  const userId = options?.actorUserId;
  return {
    store: createObligationPrismaStore(tx),
    recordChange: async (change: ObligationChange) => {
      let actor: SensorActor;
      let source: SensorSource;
      if (change.bySystem) {
        actor = { type: "SYSTEM" };
        source = "SYSTEM";
      } else if (userId != null) {
        actor = { type: "OWNER_USER", userId };
        source = "OWNER_UI";
      } else {
        actor = { type: "UNKNOWN" };
        source = "UNKNOWN";
      }
      await recordSensor(
        {
          businessId: change.businessId,
          sensor: "OBLIGATION_CHANGED",
          entityId: change.obligationId,
          actor,
          source,
          payload: {
            action: change.action,
            fields: change.fields,
            ...(change.amountChanged !== undefined
              ? { amountChanged: change.amountChanged }
              : {}),
            ...(change.dueAtChanged !== undefined
              ? { dueAtChanged: change.dueAtChanged }
              : {}),
          },
        },
        tx ? { tx } : undefined
      );
    },
  };
}
