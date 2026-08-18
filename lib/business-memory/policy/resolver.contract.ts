/**
 * Business Memory IMPL-5B · Exact Derivation Policy Resolver — CONTRACT (types + narrow client).
 *
 * Translates an EXPLICIT governed descriptor { policyKey, versionLabel } to the exact
 * DerivationPolicyVersion.id. This is BINDING RESOLUTION, not policy selection: there is no
 * current/latest/active/default, no findFirst, no numeric hardcoded id. Read-only.
 *
 * Narrow injectable client (a structural subset of Prisma, findUnique-only) so the Resolver is
 * unit-testable with a fake and cannot mutate.
 */

/** The explicit governed identity a caller must supply (Bootstrap/Resolution v1, D2 = R1). */
export interface PolicyDescriptor {
  readonly policyKey: string;
  readonly versionLabel: string;
}

/** The resolved identity. `policyVersionId` is the exact DerivationPolicyVersion.id to pin on a Claim. */
export interface ResolvedPolicyVersion {
  readonly policyKey: string;
  readonly versionLabel: string;
  readonly policyId: number;
  readonly policyVersionId: number;
}

/** Read-only client surface: exactly the two findUnique lookups the Resolver needs. No mutation ops. */
export interface PolicyResolverClient {
  derivationPolicy: {
    findUnique(args: { where: { key: string }; select: { id: true } }): Promise<{ id: number } | null>;
  };
  derivationPolicyVersion: {
    findUnique(args: {
      where: { policyId_version: { policyId: number; version: string } };
      select: { id: true };
    }): Promise<{ id: number } | null>;
  };
}

export class PolicyResolutionFailed extends Error {
  constructor(message: string) {
    super(`[business-memory/policy] ${message}`);
    this.name = "PolicyResolutionFailed";
  }
}
