/**
 * Business Memory IMPL-3 · Derivation — PUBLIC SURFACE (barrel).
 *
 * The pure Memory Deriver + first (vendor-category) derivation policy + output contract. INERT /
 * UNWIRED: no product code imports this. No persistence, no writer, no read-switch, no VendorLearning /
 * RIA / C1 dependency.
 */
export type {
  ClaimType,
  DerivedClaimState,
  DerivedClaimCandidate,
  DerivedClaimResult,
  DeriveOptions,
} from "./claim-candidate.contract";
export { deriveVendorCategory } from "./memory-deriver";
export {
  deriveVendorCategoryCandidates,
  VENDOR_CATEGORY_POLICY_NAME,
  VENDOR_CATEGORY_POLICY,
} from "./vendor-category.policy";
