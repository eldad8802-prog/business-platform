/**
 * Father Engine — C0 / PR2. Engine Epoch Registry.
 *
 * A versioned epoch links a Concept Registry snapshot digest to an execution
 * policy version (the Policy itself lands in PR4; here the epoch only PINS its
 * version string). Lookup is deterministic by epochId only.
 *
 * Note the three distinct shapes: `EngineEpochId` (the identity), `EngineEpoch`
 * (the reference embedded in a COT's ExecutionContext, PR1), and
 * `EngineEpochDefinition` (this full catalog record). Different names, different
 * meanings — never interchanged.
 */

import { buildSnapshot, type RegistrySnapshot } from "./registry-snapshot";
import type {
  EngineEpochId,
  ExecutionPolicyVersion,
  RegistrySnapshotDigest,
} from "../versioning.types";

export interface EngineEpochDefinition {
  epochId: EngineEpochId;
  conceptRegistrySnapshot: RegistrySnapshotDigest;
  executionPolicyVersion: ExecutionPolicyVersion;
  effectiveFrom: string;
}

export type EpochLookupResult =
  | { status: "FOUND"; definition: EngineEpochDefinition }
  | { status: "UNKNOWN_EPOCH"; epochId: EngineEpochId };

export interface EngineEpochRegistry {
  readonly snapshot: RegistrySnapshot<EngineEpochDefinition>;
  resolve(epochId: EngineEpochId): EpochLookupResult;
}

export function buildEngineEpochRegistry(
  entries: readonly EngineEpochDefinition[]
): EngineEpochRegistry {
  const snapshot = buildSnapshot("engine-epoch", entries, (e) => ({
    epochId: e.epochId,
  }));

  const registry: EngineEpochRegistry = {
    snapshot,
    resolve(epochId) {
      const definition = snapshot.entries.find((e) => e.epochId === epochId);
      if (!definition) return { status: "UNKNOWN_EPOCH", epochId };
      return { status: "FOUND", definition };
    },
  };

  return Object.freeze(registry);
}
