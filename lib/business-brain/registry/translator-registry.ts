/**
 * Father Engine — C0 / PR2. Translator Registry.
 *
 * Declares translators by stable name + explicit version. This is a definition
 * catalog only — there is NO live translator here and NO reading from any Source
 * of Truth. `TranslatorName` / `TranslatorVersionTag` are the SAME shared brands
 * used inside the COT's TranslatorVersion value object (no parallel types).
 */

import { buildSnapshot, type RegistrySnapshot } from "./registry-snapshot";
import type {
  TranslatorContractDigest,
  TranslatorName,
  TranslatorVersionTag,
} from "../versioning.types";

export interface TranslatorDefinition {
  translatorName: TranslatorName;
  version: TranslatorVersionTag;
  /** Content-derived fingerprint of the translator's declared contract. Same
   *  (name,version) with a different digest is a REGISTRY_IMMUTABLE_VIOLATION. */
  translatorContractDigest: TranslatorContractDigest;
  semanticDefinition: string;
  effectiveFrom: string;
}

export type TranslatorLookupResult =
  | { status: "FOUND"; definition: TranslatorDefinition }
  | { status: "UNKNOWN_TRANSLATOR"; translatorName: TranslatorName }
  | {
      status: "UNKNOWN_VERSION";
      translatorName: TranslatorName;
      version: TranslatorVersionTag;
    };

export interface TranslatorRegistry {
  readonly snapshot: RegistrySnapshot<TranslatorDefinition>;
  resolve(
    translatorName: TranslatorName,
    version: TranslatorVersionTag
  ): TranslatorLookupResult;
}

export function buildTranslatorRegistry(
  entries: readonly TranslatorDefinition[]
): TranslatorRegistry {
  const snapshot = buildSnapshot("translator", entries, (e) => ({
    translatorName: e.translatorName,
    version: e.version,
  }));

  const registry: TranslatorRegistry = {
    snapshot,
    resolve(translatorName, version) {
      const named = snapshot.entries.filter((e) => e.translatorName === translatorName);
      if (named.length === 0) return { status: "UNKNOWN_TRANSLATOR", translatorName };
      const definition = named.find((e) => e.version === version);
      if (!definition) return { status: "UNKNOWN_VERSION", translatorName, version };
      return { status: "FOUND", definition };
    },
  };

  return Object.freeze(registry);
}
