/**
 * Father Engine — C0 / PR2. Business Concept Registry.
 *
 * Canonical, versioned catalog of World Concepts. Identity = (conceptId,
 * conceptVersion); the rest is definition content. A conceptId is CLEAN of the
 * aspect (the aspect lives only in `aspect`) so the identity can never contradict
 * the definition. Lookups return an explicit typed result — never `undefined`,
 * never a throw. Semantic mutation of an existing (id,version) is rejected at
 * build time (see buildSnapshot).
 */

import { buildSnapshot, type RegistrySnapshot } from "./registry-snapshot";
import type { ConceptId, ConceptVersion } from "../versioning.types";
import type { Mode, ReferentType, Scale } from "../observation.types";

export type ConceptAspect =
  | "Established"
  | "Fulfilled"
  | "Settled"
  | "Reversed"
  | "Observed"
  | "Received"
  | "Sent"
  | "Expired"
  | "Changed";

export interface ConceptValueShape {
  mode: Mode;
  scale: Scale;
  unitDimension?: string;
}

export interface BusinessConceptDefinition {
  conceptId: ConceptId;
  conceptVersion: ConceptVersion;
  referentType: ReferentType;
  aspect: ConceptAspect;
  valueShape: ConceptValueShape;
  semanticDefinition: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export type ConceptLookupResult =
  | { status: "FOUND"; definition: BusinessConceptDefinition }
  | { status: "UNKNOWN_CONCEPT"; conceptId: ConceptId }
  | { status: "UNKNOWN_VERSION"; conceptId: ConceptId; conceptVersion: ConceptVersion };

export interface ConceptRegistry {
  readonly snapshot: RegistrySnapshot<BusinessConceptDefinition>;
  resolve(conceptId: ConceptId, conceptVersion: ConceptVersion): ConceptLookupResult;
  /** All versions of a concept (read-only). Time-based selection is PR3/Normalize. */
  listVersions(conceptId: ConceptId): readonly BusinessConceptDefinition[];
}

export function buildConceptRegistry(
  entries: readonly BusinessConceptDefinition[]
): ConceptRegistry {
  const snapshot = buildSnapshot("concept", entries, (e) => ({
    conceptId: e.conceptId,
    conceptVersion: e.conceptVersion,
  }));

  const registry: ConceptRegistry = {
    snapshot,
    resolve(conceptId, conceptVersion) {
      const versions = snapshot.entries.filter((e) => e.conceptId === conceptId);
      if (versions.length === 0) return { status: "UNKNOWN_CONCEPT", conceptId };
      const definition = versions.find((e) => e.conceptVersion === conceptVersion);
      if (!definition) return { status: "UNKNOWN_VERSION", conceptId, conceptVersion };
      return { status: "FOUND", definition };
    },
    listVersions(conceptId) {
      return snapshot.entries.filter((e) => e.conceptId === conceptId);
    },
  };

  return Object.freeze(registry);
}
