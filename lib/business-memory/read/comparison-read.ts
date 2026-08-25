/**
 * Business Memory READ-4 · Comparison-only product wiring (dark by default).
 *
 * A thin wrapper the extraction/suggestion path calls INSTEAD of decideCategory. It:
 *   - computes the incumbent EXACTLY ONCE (decideCategory);
 *   - when BUSINESS_MEMORY_READ is OFF (default): returns the incumbent verbatim — the Coordinator is
 *     never called, no resolver/Claim/evidence read, no comparison log (baseline-equivalent);
 *   - when ON: runs the READ-3 Coordinator with the incumbent INJECTED (so it is not recomputed —
 *     no recursion, no duplicate VendorLearning/keyword lookup), emits a privacy-safe comparison log,
 *     and STILL returns `effective` (=== incumbent). This is comparison/shadow-read, NOT a read-switch:
 *     the memory category is NEVER applied, even when supported/fresh/disagreeing.
 *
 * Any memory-side failure (resolver/Claim/evidence/logger/unexpected) → the incumbent. Logging never
 * affects the product result. No write, no materialization, no override.
 */
import { decideCategory } from "@/lib/services/documents/category-decision.service";
import { resolveVendorCategoryWithMemory, defaultCoordinatorDeps } from "./coordinator";
import type { CoordinatorDeps, IncumbentDecision, VendorCategoryDecision } from "./coordinator.contract";
import { isReadEnabled } from "./read-config";
import { persistComparisonObservation } from "./comparison-sink";

export type ComparisonResult = "agree" | "disagree" | "not-applicable";

/** Privacy-safe comparison log. NO vendor / normalized subject / category value / evidence payload. */
export interface ComparisonLog {
  readonly event: "bm-read-comparison";
  readonly businessId: number;
  readonly outcome: "memory-available" | "fallback";
  readonly fallbackReason: string | null;
  readonly policyKey?: string;
  readonly versionLabel?: string;
  readonly fingerprintMatch?: boolean;
  readonly comparison: ComparisonResult;
}

export interface ComparisonDeps {
  decideCategory: (businessId: number, vendorName: string, text: string) => Promise<IncumbentDecision>;
  isReadEnabled: () => boolean;
  runCoordinator: (
    input: { businessId: number; vendorName: string; text: string },
    deps: CoordinatorDeps,
  ) => Promise<VendorCategoryDecision>;
  buildCoordinatorDeps: () => CoordinatorDeps;
  // Awaitable: the caller AWAITS this so the durable telemetry write gets a reliable chance to complete
  // within the invocation (serverless can freeze after response — a detached write may be dropped). It
  // stays best-effort: it must never throw, and the caller wraps it so a failure can't affect the result.
  log: (entry: ComparisonLog) => void | Promise<void>;
}

export function defaultComparisonDeps(): ComparisonDeps {
  return {
    decideCategory: (businessId, vendorName, text) => decideCategory(businessId, vendorName, text),
    isReadEnabled: () => isReadEnabled(),
    runCoordinator: (input, deps) => resolveVendorCategoryWithMemory(input, deps),
    buildCoordinatorDeps: () => defaultCoordinatorDeps(),
    log: async (entry) => {
      // Ephemeral runtime log (kept) + durable telemetry sink (queryable via a gated SELECT). Both are
      // best-effort and can never affect the product result. The durable write is AWAITED (below, by the
      // caller) so it is not detached from the invocation lifecycle; persistComparisonObservation never
      // throws, so awaiting stays safe.
      try {
        console.info(JSON.stringify(entry));
      } catch {
        /* logging must never affect the product result */
      }
      await persistComparisonObservation(entry);
    },
  };
}

/** agree/disagree ONLY for supported+fresh (compares memory vs incumbent category); else not-applicable. */
function classify(decision: VendorCategoryDecision, incumbent: IncumbentDecision): ComparisonResult {
  if (decision.memory.status === "supported" && decision.memory.fresh) {
    return decision.memory.category === incumbent.category ? "agree" : "disagree";
  }
  return "not-applicable";
}

function buildLog(decision: VendorCategoryDecision, incumbent: IncumbentDecision): ComparisonLog {
  const o = decision.observation;
  return {
    event: "bm-read-comparison",
    businessId: o.businessId,
    outcome: o.outcome,
    fallbackReason: o.fallbackReason,
    ...(o.policyKey ? { policyKey: o.policyKey } : {}),
    ...(o.versionLabel ? { versionLabel: o.versionLabel } : {}),
    ...(o.fingerprintMatch === undefined ? {} : { fingerprintMatch: o.fingerprintMatch }),
    comparison: classify(decision, incumbent),
  };
}

/**
 * Category suggestion with OPTIONAL Business Memory comparison. Returns the SAME shape/value as
 * decideCategory — the product decision is ALWAYS the incumbent.
 */
export async function categorySuggestionWithComparison(
  businessId: number,
  vendorName: string,
  text: string,
  deps: ComparisonDeps = defaultComparisonDeps(),
): Promise<IncumbentDecision> {
  // Incumbent — computed EXACTLY ONCE.
  const incumbent = await deps.decideCategory(businessId, vendorName, text);

  // Flag OFF (default): existing behavior, coordinator never called.
  if (!deps.isReadEnabled()) return incumbent;

  try {
    // Inject the precomputed incumbent so the Coordinator does not recompute it (no recursion, no
    // duplicate VendorLearning/keyword lookup). Every other collaborator is the real read-only one.
    const coordinatorDeps: CoordinatorDeps = {
      ...deps.buildCoordinatorDeps(),
      decideCategory: async () => incumbent,
    };
    const decision = await deps.runCoordinator({ businessId, vendorName, text }, coordinatorDeps);
    try {
      // AWAITED so the durable telemetry write completes within the invocation (not a detached promise
      // that a serverless freeze could drop). Wrapped so a logging failure never affects the result.
      await deps.log(buildLog(decision, incumbent));
    } catch {
      /* logging failure never affects the product result */
    }
    // comparison-only: NEVER the memory candidate.
    return decision.effective;
  } catch {
    // any memory-side failure → incumbent
    return incumbent;
  }
}
