/**
 * Father Engine — C0 (Canonical Observation Model).
 *
 * The identity contract — three distinct identifiers, computed, never authored:
 *
 *   sourceObservationId  = hash(source anchor ONLY)         "which source slot"
 *   canonicalHash        = hash(full content + context)     "what this account says"
 *   observationAccountId = hash(source id + canonicalHash)  "this frozen account"
 *
 * Consequences (all covered by observation-identity.verify.test.ts):
 *   • sourceObservationId is stable across content / context / epoch / translator
 *     version changes — it identifies the world source slot, not the reading.
 *   • Any change to any content or context field → new canonicalHash → new
 *     observationAccountId → a NEW append-only sibling Account. Never a mutation.
 *   • Identical content built in any key order → identical ids (determinism +
 *     retry idempotency), because canonicalize() is order-independent.
 *   • InferenceSubstrate.runId is inside content → distinct runs are distinct
 *     Accounts even with identical output (Account = the act, not the value).
 */

import { canonicalize, sha256Hex } from "./canonical-serialize";
import { deepFreeze } from "./deep-freeze";
import type {
  CanonicalHash,
  CanonicalObservation,
  ObservationAccountId,
  ObservationContent,
  SourceObservationId,
} from "./observation.types";

/** Logical Source Identity — derived from the source anchor ONLY. Uses the STABLE
 *  translator name (context.translatorVersion.translatorName), never its version. */
export function computeSourceObservationId(
  content: ObservationContent
): SourceObservationId {
  const anchor = {
    businessId: content.tenant.businessId,
    featureDomain: content.source.featureDomain,
    sourceModel: content.source.sourceModel,
    sourceRecordId: content.source.sourceRecordId,
    translatorName: content.context.translatorVersion.translatorName,
    emittedObservationIndex: content.source.emittedObservationIndex,
  };
  return ("src_" + sha256Hex(canonicalize(anchor))) as SourceObservationId;
}

/** Content fingerprint — covers the entire content object (all fields + context),
 *  which excludes the three identity fields by construction (ObservationContent). */
export function computeCanonicalHash(content: ObservationContent): CanonicalHash {
  return ("sha256:" + sha256Hex(canonicalize(content))) as CanonicalHash;
}

/** Immutable Account Identity — binds a content fingerprint to a source slot. */
export function computeObservationAccountId(
  sourceObservationId: SourceObservationId,
  canonicalHash: CanonicalHash
): ObservationAccountId {
  return ("acc_" +
    sha256Hex(
      canonicalize({ sourceObservationId, canonicalHash })
    )) as ObservationAccountId;
}

/** Seal content into an immutable CanonicalObservation. Pure and idempotent:
 *  equal content always yields an identical, frozen Account. */
export function sealObservation(
  content: ObservationContent
): CanonicalObservation {
  const sourceObservationId = computeSourceObservationId(content);
  const canonicalHash = computeCanonicalHash(content);
  const observationAccountId = computeObservationAccountId(
    sourceObservationId,
    canonicalHash
  );
  return deepFreeze({
    ...content,
    sourceObservationId,
    observationAccountId,
    canonicalHash,
  });
}
