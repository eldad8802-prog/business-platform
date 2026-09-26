/**
 * Production dependency wiring for the obligations services.
 *
 * Routes call the services with `obligationServiceDeps()` and never reach for
 * Prisma directly — mirroring the payments domain DI pattern.
 */

import { createObligationPrismaStore } from "./obligation-store.prisma";
import { createObligationLedgerStore } from "./obligation-store.ledger";
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
export type SecretaryStoreMode = "legacy" | "ledger";

/**
 * Where the secretary reads and writes (Phase 2 cutover switch).
 *
 *   unset / "false"  legacy — `BusinessObligation` (today's Production)
 *   "true"           ledger — Commitment / Installment / InstallmentWorkflow
 *
 * Anything else throws: a typo must never silently pick a store, exactly as
 * `authPlaneMode` refuses to guess. Turning it on is an OWNER GATE — it goes
 * with the Production copy of every obligation the backfill never saw
 * (`scripts/payables/secretary-ledger-cutover.ts`), never before it.
 */
export function secretaryStoreMode(): SecretaryStoreMode {
  const raw = process.env.SECRETARY_LEDGER_STORE?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "false") return "legacy";
  if (raw === "true") return "ledger";
  throw new Error(
    `SECRETARY_LEDGER_STORE must be exactly "true" or "false" (received ${JSON.stringify(raw)}). ` +
      "Refusing to guess where the secretary's truth lives."
  );
}

export function obligationServiceDeps(options?: {
  tx?: TenantTx;
  actorUserId?: number;
}): ObligationServiceDeps {
  const tx = options?.tx;
  const userId = options?.actorUserId;
  let store;
  if (secretaryStoreMode() === "ledger") {
    // The ledger store composes payables writes, which must share the route's
    // tenant transaction; there is no transaction-less fallback on purpose.
    if (!tx) throw new Error("The ledger secretary store requires the route's tenant transaction");
    store = createObligationLedgerStore(tx, { actorUserId: userId ?? null });
  } else {
    store = createObligationPrismaStore(tx);
  }
  return {
    store,
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
