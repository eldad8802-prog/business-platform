/**
 * M7-A — one adapter shape for every commerce source. A provider supplies only its trusted resolver
 * (and, if it only notifies, a hydrate step); normalize is the ONE commerce normalizer and the order is
 * written by the CORE commerce destination (R5 → routeToCommerce), so identity, the order, its history,
 * the Secretary and the sensors are the same for every store.
 *
 * No commerce adapter is registered in Production in M7-A (the providers ship in M7-B, each behind its
 * own feature, OFF). The lab registers reference adapters built with this factory.
 */
import type { IntakeAdapter, RouteResult } from "@/lib/intake/core/contract";
import { listAcquisitionTenants } from "@/lib/intake/acquisition/resolve";
import { connectionStateForRef } from "@/lib/intake/acquisition/connection.service";
import { normalizeCommerceOrder, type CommerceSourceKey } from "./canonical";

export const COMMERCE_NORMALIZER_VERSION = 1;

export function makeCommerceAdapter(input: {
  sourceKey: CommerceSourceKey;
  resolveTenant: IntakeAdapter["resolveTenant"];
  hydrate?: IntakeAdapter["hydrate"];
}): IntakeAdapter {
  return {
    sourceKey: input.sourceKey,
    families: ["COMMERCE"],
    normalizerVersion: `${input.sourceKey}@${COMMERCE_NORMALIZER_VERSION}`,
    coreDestinations: ["commerce"],
    resolveTenant: input.resolveTenant,
    // Every retry first re-checks the connection: a receipt whose connection was revoked after it
    // arrived (store disconnected, account erased) is settled IGNORED — never an order.
    async hydrate(ctx, event) {
      if ((await connectionStateForRef(input.sourceKey, event.providerAccountRef)) === "revoked") {
        return { kind: "ignored", code: "connection_revoked" };
      }
      return input.hydrate ? input.hydrate(ctx, event) : { kind: "unchanged" };
    },
    normalize: normalizeCommerceOrder,
    // Reached only if a COMMERCE event were routed away from the core destination: nothing to write.
    async route(): Promise<RouteResult> {
      return { kind: "ignored", code: "not_an_order" };
    },
    listTenants: () => listAcquisitionTenants(input.sourceKey),
  };
}
