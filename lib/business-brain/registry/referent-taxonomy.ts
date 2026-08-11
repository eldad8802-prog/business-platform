/**
 * Father Engine — C0 / PR2. Referent Taxonomy.
 *
 * Parents are the fixed PR1 ReferentType union (PARTY / COMMITMENT / RESOURCE).
 * Subtypes are additive definitions. v1 is EXACT-MATCH ONLY — there is no
 * subsumption / hierarchy walking (that awaits an approved spec). Adding a
 * subtype therefore cannot change how a parent resolves.
 */

import { buildSnapshot, type RegistrySnapshot } from "./registry-snapshot";
import type { ReferentSubtype } from "../versioning.types";
import type { ReferentType } from "../observation.types";

export interface ReferentSubtypeDefinition {
  referentType: ReferentType;
  subtype: ReferentSubtype;
  semanticDefinition: string;
  effectiveFrom: string;
}

export type ReferentResolveResult =
  | { status: "FOUND"; referentType: ReferentType; subtype?: ReferentSubtype }
  | { status: "UNKNOWN_TYPE"; referentType: string }
  | { status: "UNKNOWN_SUBTYPE"; referentType: ReferentType; subtype: ReferentSubtype };

export interface ReferentTaxonomy {
  readonly snapshot: RegistrySnapshot<ReferentSubtypeDefinition>;
  resolve(referentType: string, subtype?: ReferentSubtype): ReferentResolveResult;
}

const PARENTS: readonly ReferentType[] = ["PARTY", "COMMITMENT", "RESOURCE"];

export function buildReferentTaxonomy(
  subtypes: readonly ReferentSubtypeDefinition[]
): ReferentTaxonomy {
  const snapshot = buildSnapshot("referent", subtypes, (e) => ({
    referentType: e.referentType,
    subtype: e.subtype,
  }));

  const isParent = (t: string): t is ReferentType =>
    (PARENTS as readonly string[]).includes(t);

  const taxonomy: ReferentTaxonomy = {
    snapshot,
    resolve(referentType, subtype) {
      if (!isParent(referentType)) return { status: "UNKNOWN_TYPE", referentType };
      if (subtype === undefined) return { status: "FOUND", referentType };
      const found = snapshot.entries.some(
        (e) => e.referentType === referentType && e.subtype === subtype
      );
      if (!found) return { status: "UNKNOWN_SUBTYPE", referentType, subtype };
      return { status: "FOUND", referentType, subtype };
    },
  };

  return Object.freeze(taxonomy);
}
