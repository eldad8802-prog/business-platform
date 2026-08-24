/**
 * Business Memory READ-2 (R1) · Claim Reader — PUBLIC SURFACE (barrel).
 *
 * INERT / UNWIRED: exporting this barrel wires nothing. No product code imports it. The reader is a pure,
 * tenant-scoped, read-only Projection lookup — no coordinator, no staleness, no fallback, no env flag.
 */
export type {
  ReadClaimQuery,
  ReadClaimResult,
  ClaimReaderClient,
  ClaimReaderProjectionRow,
  ClaimReaderCandidateRow,
  ClaimIdentityWhere,
} from "./read-claim.contract";
export { readClaim } from "./claim-reader";
export type {
  IncumbentDecision,
  FallbackReason,
  MemoryOutcome,
  CoordinatorObservation,
  VendorCategoryDecision,
  CoordinatorInput,
  CoordinatorDeps,
  EvidenceIdentity,
  ResolvedPolicyIdentity,
} from "./coordinator.contract";
export { resolveVendorCategoryWithMemory, defaultCoordinatorDeps } from "./coordinator";
export { isReadEnabled } from "./read-config";
export {
  categorySuggestionWithComparison,
  defaultComparisonDeps,
  type ComparisonDeps,
  type ComparisonLog,
  type ComparisonResult,
} from "./comparison-read";
