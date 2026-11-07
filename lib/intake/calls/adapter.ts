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
import { HOLD_CODES, HOLD_RECHECK_MS, holdOrExpire, holdUnlessAllowed } from "@/lib/intake/acquisition/gate";
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
      const connectionState = await connectionStateForRef(input.sourceKey, event.providerAccountRef);
      if (connectionState === "revoked") {
        return { kind: "ignored", code: "connection_revoked" };
      }
      // Leads L1.5-a · decision 3 — a PAUSED connection: the receipt waits (no attempt, nothing deleted) until resumed.
      if (connectionState === "paused") {
        // L1.5-b · PR-6 — past the expiry age (only when switched on) the receipt is settled instead of waiting again.
        return holdOrExpire({ kind: "deferred", until: new Date(ctx.now.getTime() + HOLD_RECHECK_MS), code: HOLD_CODES.connectionPaused }, event.receivedAt, ctx.now);
      }
      // L1.5-a — then the source gate, again, before any work: emergency switch, entitlement withdrawn or a
      // quarantined business → the receipt waits (deferred, not an attempt, nothing deleted).
      const hold = await holdUnlessAllowed(ctx.businessId, input.sourceKey, ctx.now);
      if (hold) return holdOrExpire(hold, event.receivedAt, ctx.now);
      return input.hydrate ? input.hydrate(ctx, event) : { kind: "unchanged" };
    },
    normalize: normalizeCall,
    async route(): Promise<RouteResult> {
      return { kind: "ignored", code: "not_a_call" };
    },
    listTenants: () => listAcquisitionTenants(input.sourceKey),
  };
}
