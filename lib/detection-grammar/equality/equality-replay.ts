/**
 * Detection Grammar — Equality · deterministic operation-identity + replay helper.
 *
 * ED1 defers the concrete hashing / replay-key mechanism; this reuses C0's canonical
 * serialization so the digest is byte-stable and object-key-order-independent, while
 * remaining ORDER-SENSITIVE over the relatum tuple ([a,b] != [b,a]) — preserving
 * ED1's ordered, orientation-preserving Operation identity. ED3 — determinism is
 * asserted for SUCCESSFUL Outcomes only; Failure determinism is not locked and is
 * not claimed here. This digest is a proof-local convenience, not a governance rule.
 */
import { canonicalize, sha256Hex } from "../../business-brain/canonical-serialize";
import type {
  EqualityProjection,
  OperationIdentityDigest,
  OperationSpec,
} from "./equality.types";

/** A deterministic digest of the ordered Operation specification (ED1/ED4). */
export function operationIdentityDigest(spec: OperationSpec): OperationIdentityDigest {
  // canonicalize sorts object keys but preserves ARRAY order, so orderedRelatumRefs
  // keeps its [a,b] orientation (ED1) while the spec object is order-independent.
  return ("opid:sha256:" + sha256Hex(canonicalize(spec))) as OperationIdentityDigest;
}

/**
 * Two projections replay-equal iff they share the same Operation identity AND the
 * same successful Outcome (ED3 successful-Outcome determinism). Failure dispositions
 * are deliberately NOT compared for determinism (ED3 — failure determinism is not
 * locked), so this returns false for any Failure disposition.
 */
export function projectionsReplayEqual(
  a: EqualityProjection,
  b: EqualityProjection
): boolean {
  if (a.operationIdentityDigest !== b.operationIdentityDigest) return false;
  if (a.disposition.kind === "OUTCOME" && b.disposition.kind === "OUTCOME") {
    return a.disposition.outcome === b.disposition.outcome;
  }
  return false;
}
