/**
 * M7-A — one adapter shape for every telephony source. A provider supplies only its trusted resolver;
 * normalize is the ONE call normalizer and the call is written by the CORE call destination
 * (R9 → routeToCall), so identity, the call, the Secretary and the sensors are the same for every
 * provider.
 *
 * No telephony adapter is registered in Production in M7-A (the providers ship in M7-C, each behind its
 * own feature, OFF). The lab registers reference adapters built with this factory.
 */
import type { IntakeAdapter, RouteResult } from "@/lib/intake/core/contract";
import { listAcquisitionTenants } from "@/lib/intake/acquisition/resolve";
import { connectionStateForRef } from "@/lib/intake/acquisition/connection.service";
import { normalizeCall, type TelephonySourceKey } from "./canonical";

export const CALL_NORMALIZER_VERSION = 1;

export function makeCallAdapter(input: {
  sourceKey: TelephonySourceKey;
  resolveTenant: IntakeAdapter["resolveTenant"];
  /** M7-C — a provider whose webhook does not carry everything (CloudTalk: no outcome) completes the receipt here. */
  hydrate?: IntakeAdapter["hydrate"];
}): IntakeAdapter {
  return {
    sourceKey: input.sourceKey,
    families: ["CALL"],
    normalizerVersion: `${input.sourceKey}@${CALL_NORMALIZER_VERSION}`,
    coreDestinations: ["call"],
    resolveTenant: input.resolveTenant,
    async hydrate(ctx, event) {
      if ((await connectionStateForRef(input.sourceKey, event.providerAccountRef)) === "revoked") {
        return { kind: "ignored", code: "connection_revoked" };
      }
      return input.hydrate ? input.hydrate(ctx, event) : { kind: "unchanged" };
    },
    normalize: normalizeCall,
    async route(): Promise<RouteResult> {
      return { kind: "ignored", code: "not_a_call" };
    },
    listTenants: () => listAcquisitionTenants(input.sourceKey),
  };
}
