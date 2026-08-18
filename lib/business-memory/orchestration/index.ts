/**
 * Business Memory IMPL-6A · Orchestration — PUBLIC SURFACE (barrel).
 *
 * The inert single-pass Orchestrator that composes Adapter → Resolver → Deriver → Writer under a
 * best-effort (G1) double-read freshness check with S1 stale handling. INERT / UNWIRED: no product
 * caller, no trigger, no VendorLearning. It adds no derivation/selection/confidence semantics.
 */
export type {
  OrchestratorInput,
  OrchestratorOutcome,
  OrchestratorDeps,
  OrchestratorFailureStage,
  OrchestratorPolicyIdentity,
} from "./orchestrator.contract";
export { runVendorCategoryOrchestration, defaultOrchestratorDeps } from "./orchestrator";
export { evidenceIdentityEquals } from "./evidence-identity";
