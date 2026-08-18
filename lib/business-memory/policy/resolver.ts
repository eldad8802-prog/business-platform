/**
 * Business Memory IMPL-5B · Exact Derivation Policy Resolver (read-only, inert).
 *
 * `resolveDerivationPolicyVersion({ policyKey, versionLabel })` → the exact DerivationPolicyVersion.id,
 * via two deterministic findUnique lookups on GOVERNED identities:
 *   1) DerivationPolicy.findUnique({ key })                          — the unique lineage identity
 *   2) DerivationPolicyVersion.findUnique({ policyId_version })       — the (policyId, version) identity
 *
 * BINDING, not selection: no current/latest/active/default, no findFirst, no orderBy, no max(version),
 * no numeric hardcoded id. Read-only: the client surface exposes only findUnique. Fail-closed: a missing
 * lineage or version throws PolicyResolutionFailed (never create-if-missing, never a fallback version).
 *
 * INERT: no Writer invocation, no Deriver, no evidence, no VendorLearning, no product caller.
 */
import { prisma } from "@/lib/prisma";
import { VENDOR_CATEGORY_POLICY } from "@/lib/business-memory/derivation";
import {
  PolicyResolutionFailed,
  type PolicyDescriptor,
  type PolicyResolverClient,
  type ResolvedPolicyVersion,
} from "./resolver.contract";

/**
 * Resolve an explicit governed descriptor to its exact persisted policy-version identity.
 * `client` is injectable (default: Prisma) so the Resolver is unit-testable without a DB.
 */
export async function resolveDerivationPolicyVersion(
  descriptor: PolicyDescriptor,
  client: PolicyResolverClient = prisma as unknown as PolicyResolverClient,
): Promise<ResolvedPolicyVersion> {
  const policyKey = descriptor?.policyKey;
  const versionLabel = descriptor?.versionLabel;
  if (typeof policyKey !== "string" || policyKey.length === 0) {
    throw new PolicyResolutionFailed("descriptor.policyKey must be a non-empty string");
  }
  if (typeof versionLabel !== "string" || versionLabel.length === 0) {
    throw new PolicyResolutionFailed("descriptor.versionLabel must be a non-empty string");
  }

  // 1) Resolve the lineage by its governed unique key (NOT the DB id, NOT findFirst).
  const policy = await client.derivationPolicy.findUnique({ where: { key: policyKey }, select: { id: true } });
  if (!policy) {
    throw new PolicyResolutionFailed(`no derivation policy lineage for key '${policyKey}'`);
  }

  // 2) Resolve the exact version within that lineage (identity, not precedence). versionLabel="v1" alone
  //    is NOT sufficient — it is scoped to policy.id, so cross-lineage same-label rows never collide.
  const version = await client.derivationPolicyVersion.findUnique({
    where: { policyId_version: { policyId: policy.id, version: versionLabel } },
    select: { id: true },
  });
  if (!version) {
    throw new PolicyResolutionFailed(`no version '${versionLabel}' under policy lineage '${policyKey}'`);
  }

  return { policyKey, versionLabel, policyId: policy.id, policyVersionId: version.id };
}

/**
 * Convenience binding for the one v1 use-case — resolves the canonical VENDOR_CATEGORY_POLICY descriptor
 * (single source of truth) through the generic Resolver. No duplicated strings, no hardcoded id.
 */
export async function resolveVendorCategoryPolicyVersion(
  client: PolicyResolverClient = prisma as unknown as PolicyResolverClient,
): Promise<ResolvedPolicyVersion> {
  return resolveDerivationPolicyVersion(
    { policyKey: VENDOR_CATEGORY_POLICY.policyKey, versionLabel: VENDOR_CATEGORY_POLICY.versionLabel },
    client,
  );
}
