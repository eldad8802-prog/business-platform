/**
 * Father Engine — C0 / PR3. RealityTier boundary validation.
 *
 * normalize() depends on this INTERFACE, not on any fixed allow-list. A validator
 * carries a versioned identity AND a content-derived digest, so replay can pin the
 * vocabulary: the same vocabularyId with different content yields a different
 * vocabularyDigest → a pinning failure. No token is valid merely for being a
 * string. There is NO ranking / precedence / ceiling here — validity only.
 */

import { canonicalize, sha256Hex } from "../canonical-serialize";
import { deepFreeze } from "../deep-freeze";
import type { RealityTier } from "../observation.types";
import {
  realityTierVocabularyId,
  type RealityTierVocabularyDigest,
  type RealityTierVocabularyId,
} from "../versioning.types";

export interface RealityTierValidator {
  readonly vocabularyId: RealityTierVocabularyId;
  readonly vocabularyDigest: RealityTierVocabularyDigest;
  isValid(value: RealityTier): boolean;
}

/**
 * Build a validator from a token list. The vocabulary is canonicalised (sorted +
 * de-duplicated + deep-frozen) and its digest is derived from that content.
 */
export function buildRealityTierValidator(
  vocabularyId: RealityTierVocabularyId,
  tokens: readonly string[]
): RealityTierValidator {
  const canonicalTokens = deepFreeze([...new Set(tokens)].sort());
  const allow = new Set<string>(canonicalTokens);
  const vocabularyDigest = ("realtiervocab:sha256:" +
    sha256Hex(canonicalize(canonicalTokens))) as RealityTierVocabularyDigest;
  return Object.freeze({
    vocabularyId,
    vocabularyDigest,
    isValid: (value: RealityTier) => typeof value === "string" && allow.has(value),
  });
}

/**
 * TEST-ONLY fixture vocabulary — NOT canonical and NOT a source of truth. Exists
 * solely so PR3 fixtures have valid tiers to normalize against.
 */
export const fixtureRealityTierValidator: RealityTierValidator = buildRealityTierValidator(
  realityTierVocabularyId("fixture-tiers@1"),
  ["tier-observed", "tier-inferred", "tier-declared", "tier-self-asserted", "tier-third-party"]
);
