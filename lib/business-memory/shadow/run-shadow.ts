/**
 * Business Memory SHADOW-2 · thin dark shadow trigger (post-canonical-evidence, best-effort).
 *
 * The ONLY seam between the product (approval flow) and the Business Memory pipeline. When the kill
 * switch is ON and the owner-decision evidence was durably committed and a real subject exists, it
 * AWAITS the Orchestrator once (F1) and isolates every outcome from the caller. It NEVER throws, NEVER
 * retries, NEVER reads/writes VendorLearning, and produces no product-visible effect (S-A: materialize
 * only, no comparison). Derivation/resolution/persistence all live in the Orchestrator, not here.
 */
import { normalizeVendorForLearning } from "@/lib/services/documents/vendor-normalization.service";
import { runVendorCategoryOrchestration } from "@/lib/business-memory/orchestration";
import type { OrchestratorOutcome } from "@/lib/business-memory/orchestration";
import { isShadowEnabled } from "./shadow-config";

export interface ShadowInput {
  /** Trusted, server-derived tenant. */
  readonly businessId: number;
  /** Owner-final vendor identity (the same value written as ReviewEvent.vendorFinal). */
  readonly vendorInput: string | null;
  /** Whether the canonical ReviewEvent was actually persisted (recordReviewEvent's acknowledgement). */
  readonly evidencePersisted: boolean;
}

/** Injectable seams so the trigger is unit-testable and the flag/orchestrator can be faked. */
export interface ShadowDeps {
  enabled(): boolean;
  runOrchestration(input: { businessId: number; vendorInput: string | null }): Promise<OrchestratorOutcome>;
  observe(outcome: OrchestratorOutcome, businessId: number): void;
  observeError(error: unknown, businessId: number): void;
}

export function defaultShadowDeps(): ShadowDeps {
  return {
    enabled: () => isShadowEnabled(),
    runOrchestration: (input) => runVendorCategoryOrchestration(input),
    // Observability WITHOUT PII: never log raw vendor name / evidence / payload — only opaque fields.
    observe: (outcome, businessId) => {
      const base = { scope: "business-memory/shadow", businessId, outcome: outcome.kind } as Record<string, unknown>;
      if (outcome.kind === "materialized" || outcome.kind === "deleted" || outcome.kind === "no-op") {
        base.policy = `${outcome.policyIdentity.policyKey}@${outcome.policyIdentity.versionLabel}`;
        base.candidateCount = outcome.candidateCount;
        base.writerAction = outcome.writerAction;
      } else if (outcome.kind === "stale") {
        base.policy = `${outcome.policyIdentity.policyKey}@${outcome.policyIdentity.versionLabel}`;
      } else if (outcome.kind === "failed") {
        base.stage = outcome.stage;
      }
      console.info("[business-memory/shadow]", base);
    },
    observeError: (error, businessId) =>
      console.error("[business-memory/shadow] unexpected (non-fatal):", { businessId, error }),
  };
}

/**
 * Best-effort dark shadow materialization. Returns void and NEVER throws — the caller's result is never
 * affected. Order: flag (cheap env read) → evidence-committed → real subject → await Orchestrator once.
 */
export async function runShadowMaterialization(input: ShadowInput, deps?: ShadowDeps): Promise<void> {
  try {
    const d = deps ?? defaultShadowDeps();
    // Kill switch first: when OFF this returns immediately with zero pipeline/DB cost.
    if (!d.enabled()) return;
    // §24: never run on evidence that was not actually persisted.
    if (!input.evidencePersisted) return;
    // §7 eligibility: a real, normalizable subject must exist (silence ≠ approval; never fabricate evidence).
    const vendor = (input.vendorInput ?? "").trim();
    if (vendor.length === 0) return;
    if (normalizeVendorForLearning(vendor).normalizedKey.trim().length === 0) return;

    const outcome = await d.runOrchestration({ businessId: input.businessId, vendorInput: vendor });
    d.observe(outcome, input.businessId);
  } catch (error) {
    // Total isolation: any failure (incl. deps construction) is swallowed. No retry. Approval unaffected.
    try {
      (deps ?? defaultShadowDeps()).observeError(error, input.businessId);
    } catch {
      /* observability must never throw either */
    }
  }
}
