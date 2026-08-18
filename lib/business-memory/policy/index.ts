/**
 * Business Memory IMPL-5B · Policy resolution — PUBLIC SURFACE (barrel).
 *
 * The exact, read-only governed-descriptor → policy-version-id Resolver. INERT / UNWIRED: no product
 * caller. No Writer invocation, no Deriver, no evidence, no VendorLearning, no current/latest selection.
 */
export type {
  PolicyDescriptor,
  ResolvedPolicyVersion,
  PolicyResolverClient,
} from "./resolver.contract";
export { PolicyResolutionFailed } from "./resolver.contract";
export { resolveDerivationPolicyVersion, resolveVendorCategoryPolicyVersion } from "./resolver";
