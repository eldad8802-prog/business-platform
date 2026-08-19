/**
 * Business Memory SHADOW-2 · dark shadow wiring — PUBLIC SURFACE (barrel).
 *
 * The only product-facing seam: a best-effort, kill-switched, post-canonical-evidence trigger of the
 * Business Memory Orchestrator. Default OFF; no comparison; no VendorLearning; no Claim read path.
 */
export { isShadowEnabled } from "./shadow-config";
export { runShadowMaterialization, defaultShadowDeps, type ShadowInput, type ShadowDeps } from "./run-shadow";
