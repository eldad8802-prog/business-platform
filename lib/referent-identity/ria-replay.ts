/**
 * RIA — deterministic digests + cross-feature golden · §6.
 *
 * Governance source of truth: docs/referent-identity-authority-v1.md (RIA-1 §0–§7, RATIFIED).
 *
 * Reuses C0's canonical serialization (byte-stable, object-key-order-independent) so
 * that identical inputs — RawInputs, C0 snapshots, bindings, policy id/version,
 * assertion history, temporal context, Equality contract/domain — reproduce identical
 * digests. These digests are proof-local replay conveniences, NOT governance rules.
 *
 * Replay here is PURE: computing a digest has no side effects and does not mutate any
 * assertion, CII, or C0 account.
 */
import { canonicalize, sha256Hex } from "../business-brain/canonical-serialize";
import type { EqualityProjection } from "../detection-grammar/equality/equality.types";
import type {
  CurrentIdentityInterpretation,
  IdentityHistory,
} from "./ria.types";

export function historyDigest(history: IdentityHistory): string {
  // Assertions are content-addressed; sort by assertionId so append-order is not authority.
  const ids = history.map((a) => a.assertionId).sort();
  return "ria-history:sha256:" + sha256Hex(canonicalize(ids));
}

export function ciiDigest(cii: CurrentIdentityInterpretation): string {
  return "ria-cii:sha256:" + sha256Hex(canonicalize(cii));
}

/**
 * End-to-end cross-feature golden: the derived shared identity interpretation AND the
 * Detection-Grammar (Equality) Projection computed under it. Two runs with identical
 * pinned dependencies produce an identical golden.
 */
export function crossFeatureGolden(
  cii: CurrentIdentityInterpretation,
  projection: EqualityProjection
): string {
  return (
    "ria-xfeat:sha256:" +
    sha256Hex(
      canonicalize({
        cii,
        operationIdentityDigest: projection.operationIdentityDigest,
        disposition: projection.disposition,
      })
    )
  );
}
