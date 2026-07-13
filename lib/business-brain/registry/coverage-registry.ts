/**
 * Father Engine — C0 / PR2. Coverage Registry.
 *
 * Canonical key = referent(type+subtype) × concept × source sensor.
 * `absenceInformative` is an EXPLICIT stored policy — it is NEVER derived from
 * `coverageState`. There is no liveness detection in PR2: `SensorState.declared`
 * is a static declaration, not a probe. A missing key resolves to an explicit
 * NO_ENTRY (absence is never silently treated as "covered").
 */

import { buildSnapshot, type RegistrySnapshot } from "./registry-snapshot";
import { canonicalize } from "../canonical-serialize";
import type { ConceptId, ReferentSubtype } from "../versioning.types";
import type { ReferentType } from "../observation.types";

export type CoverageState = "FULL" | "PARTIAL" | "UNCOVERED";

export interface SensorState {
  sensorId: string;
  declared: "ACTIVE" | "INACTIVE" | "UNKNOWN"; // static declaration — no liveness
}

export interface CoverageKey {
  referentType: ReferentType;
  referentSubtype?: ReferentSubtype;
  conceptId: ConceptId;
  sourceSensor: string;
}

export interface CoverageEntry extends CoverageKey {
  coverageState: CoverageState;
  sensorState: SensorState;
  absenceInformative: boolean; // explicit policy — never inferred from coverageState
}

export type CoverageLookupResult =
  | { status: "FOUND"; entry: CoverageEntry }
  | { status: "NO_ENTRY"; key: string };

export interface CoverageRegistry {
  readonly snapshot: RegistrySnapshot<CoverageEntry>;
  resolve(key: CoverageKey): CoverageLookupResult;
}

function coverageKeyOf(k: CoverageKey): unknown {
  return {
    referentType: k.referentType,
    referentSubtype: k.referentSubtype ?? null,
    conceptId: k.conceptId,
    sourceSensor: k.sourceSensor,
  };
}

export function buildCoverageRegistry(
  entries: readonly CoverageEntry[]
): CoverageRegistry {
  const snapshot = buildSnapshot("coverage", entries, coverageKeyOf);

  const registry: CoverageRegistry = {
    snapshot,
    resolve(key) {
      const target = canonicalize(coverageKeyOf(key));
      const entry = snapshot.entries.find(
        (e) => canonicalize(coverageKeyOf(e)) === target
      );
      if (!entry) return { status: "NO_ENTRY", key: target };
      return { status: "FOUND", entry };
    },
  };

  return Object.freeze(registry);
}
