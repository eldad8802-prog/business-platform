/**
 * Father Engine — C0 / PR2. Versioned registry snapshot machinery.
 *
 * A RegistrySnapshot is an immutable, deep-frozen, digest-bearing set of Type
 * definitions (never Instances, never Tenant data). The digest is a deterministic
 * fingerprint of the WHOLE snapshot — registryKind + snapshotSchemaVersion +
 * canonically-sorted entries — so:
 *   • two builds of the same entries in any order → the same digest;
 *   • a future change to the snapshot SHAPE (schema) → a different digest that
 *     cannot masquerade as the old contract.
 *
 * buildSnapshot() is the only mint for a RegistrySnapshotDigest (plus
 * parseSnapshotDigest() for reading a persisted one back). This guarantees an
 * invented digest can never be attached to an ExecutionContext.
 *
 * Reuses PR1 primitives only (canonicalize, sha256Hex, deepFreeze) — no new
 * hashing or freezing.
 */

import { canonicalize, sha256Hex } from "../canonical-serialize";
import { deepFreeze } from "../deep-freeze";
import { BrainError } from "../brain-error";
import {
  REGISTRY_SNAPSHOT_SCHEMA_VERSION,
  type RegistrySnapshotDigest,
  type RegistrySnapshotSchemaVersion,
} from "../versioning.types";

export type RegistryKind =
  | "concept"
  | "referent"
  | "coverage"
  | "translator"
  | "engine-epoch";

export interface RegistrySnapshot<TEntry> {
  readonly kind: RegistryKind;
  readonly schemaVersion: RegistrySnapshotSchemaVersion;
  readonly entries: readonly TEntry[]; // canonically sorted + deep-frozen
  readonly digest: RegistrySnapshotDigest;
}

const DIGEST_RE =
  /^regsnap:(concept|referent|coverage|translator|engine-epoch):sha256:[0-9a-f]{64}$/;

/** Validate a persisted digest string back into a RegistrySnapshotDigest. Throws
 *  on any value not produced by buildSnapshot's format. */
export function parseSnapshotDigest(value: string): RegistrySnapshotDigest {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    throw new BrainError(
      "INVALID_VERSIONING_ID",
      `Not a valid RegistrySnapshotDigest: "${value}"`,
      { value }
    );
  }
  return value as RegistrySnapshotDigest;
}

/**
 * Build an immutable snapshot. Validates identity-key uniqueness and immutability
 * over FULL canonical content:
 *   • same key + identical content → REGISTRY_DUPLICATE_ENTRY
 *   • same key + different content → REGISTRY_IMMUTABLE_VIOLATION
 */
export function buildSnapshot<TEntry>(
  kind: RegistryKind,
  entries: readonly TEntry[],
  keyOf: (entry: TEntry) => unknown
): RegistrySnapshot<TEntry> {
  const seen = new Map<string, string>(); // canonical key -> canonical full content
  for (const entry of entries) {
    const keyStr = canonicalize(keyOf(entry));
    const contentStr = canonicalize(entry);
    const prior = seen.get(keyStr);
    if (prior !== undefined) {
      if (prior === contentStr) {
        throw new BrainError(
          "REGISTRY_DUPLICATE_ENTRY",
          `Duplicate ${kind} registry entry for key ${keyStr}`,
          { kind, key: keyStr }
        );
      }
      throw new BrainError(
        "REGISTRY_IMMUTABLE_VIOLATION",
        `Conflicting ${kind} definition for the same key ${keyStr}`,
        { kind, key: keyStr }
      );
    }
    seen.set(keyStr, contentStr);
  }

  // Canonical, insertion-order-independent ordering by key.
  const sorted = [...entries].sort((a, b) => {
    const ka = canonicalize(keyOf(a));
    const kb = canonicalize(keyOf(b));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const digestBody = canonicalize({
    registryKind: kind,
    snapshotSchemaVersion: REGISTRY_SNAPSHOT_SCHEMA_VERSION,
    entries: sorted,
  });
  const digest = (`regsnap:${kind}:sha256:` +
    sha256Hex(digestBody)) as RegistrySnapshotDigest;

  return deepFreeze({
    kind,
    schemaVersion: REGISTRY_SNAPSHOT_SCHEMA_VERSION,
    entries: sorted,
    digest,
  });
}
