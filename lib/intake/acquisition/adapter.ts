/**
 * M6 — one adapter shape for every acquisition source. A source supplies only its trusted resolver
 * (and, if the provider only notifies, a hydrate step). Normalize is the ONE canonical normalizer;
 * the lead itself is written by the CORE lead destination (M4 rule R4 → routeToLead), so identity,
 * the Lead, its lifecycle, the Secretary and the sensors are the same for every provider.
 */
import type { IntakeAdapter, RouteResult } from "@/lib/intake/core/contract";
import { normalizeAcquisitionLead } from "./canonical";
import { listAcquisitionTenants } from "./resolve";
import { connectionStateForRef } from "./connection.service";

export const ACQUISITION_NORMALIZER_VERSION = 1;

export function makeAcquisitionAdapter(input: {
  sourceKey: "meta.lead_ads" | "google.lead_form" | "web.form";
  resolveTenant: IntakeAdapter["resolveTenant"];
  hydrate?: IntakeAdapter["hydrate"];
}): IntakeAdapter {
  return {
    sourceKey: input.sourceKey,
    families: ["LEAD"],
    normalizerVersion: `${input.sourceKey}@${ACQUISITION_NORMALIZER_VERSION}`,
    coreDestinations: ["lead"],
    resolveTenant: input.resolveTenant,
    // Every retry first re-checks the connection: a receipt whose connection was revoked after it
    // arrived (key leaked, Page disconnected, account erased) is settled IGNORED — never a Lead.
    async hydrate(ctx, event) {
      if ((await connectionStateForRef(input.sourceKey, event.providerAccountRef)) === "revoked") {
        return { kind: "ignored", code: "connection_revoked" };
      }
      return input.hydrate ? input.hydrate(ctx, event) : { kind: "unchanged" };
    },
    normalize: normalizeAcquisitionLead,
    // Reached only for a non-lead target (a provider test submission → "none"): nothing to write.
    async route(_ctx, normalized): Promise<RouteResult> {
      return { kind: "ignored", code: normalized.target === "none" ? "test_submission" : "not_a_lead" };
    },
    listTenants: () => listAcquisitionTenants(input.sourceKey),
  };
}
