/**
 * Father Engine — C0 / PR4. Replay Manifest — build, digest, compare.
 *
 * The manifest is the FULL identity of a run: ordered account identities + typed
 * rejections + the pinned dependency context. Counts are DERIVED from the arrays
 * (never supplied). Rejection identity contributes only its typed, canonical
 * payload — never a free-form string.
 */

import { canonicalize, sha256Hex } from "../canonical-serialize";
import { deepFreeze } from "../deep-freeze";
import type { CanonicalObservation } from "../observation.types";
import type { NormalizationRejectionIdentity } from "../normalization/normalization-result.types";
import {
  REPLAY_MANIFEST_SCHEMA_VERSION,
  type AccountAuditManifest,
  type AccountsDigest,
  type ExecutionMode,
  type RejectionIdentityDigest,
  type ReplayComparisonResult,
  type ReplayDependencyContext,
  type ReplayDivergence,
  type ReplayManifest,
  type ReplayManifestDigest,
  type ReplayManifestEntry,
  type ReplayOutcomeSet,
  type ReplayRejectionEntry,
} from "./replay.types";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function rejectionIdentityDigest(
  identity: NormalizationRejectionIdentity
): RejectionIdentityDigest {
  return ("rejectid:sha256:" + sha256Hex(canonicalize(identity))) as RejectionIdentityDigest;
}

export function toRejectionEntry(failed: {
  source: ReplayRejectionEntry["sourceRef"];
  identity: NormalizationRejectionIdentity;
}): ReplayRejectionEntry {
  return {
    sourceRef: failed.source,
    identity: failed.identity,
    identityDigest: rejectionIdentityDigest(failed.identity),
  };
}

function accountEntry(o: CanonicalObservation): ReplayManifestEntry {
  return {
    sourceObservationId: o.sourceObservationId,
    observationAccountId: o.observationAccountId,
    canonicalHash: o.canonicalHash,
  };
}

function sortAccounts(entries: readonly ReplayManifestEntry[]): ReplayManifestEntry[] {
  return [...entries].sort((a, b) => cmp(a.observationAccountId, b.observationAccountId));
}

function rejectionSortKey(r: ReplayRejectionEntry): string {
  return canonicalize([
    r.sourceRef.ref.sourceRecordId,
    r.sourceRef.ref.sourceModel,
    r.sourceRef.ref.featureDomain,
    r.sourceRef.emittedObservationIndex ?? -1,
    r.identity.reason,
    r.identityDigest,
  ]);
}

function sortRejections(rs: readonly ReplayRejectionEntry[]): ReplayRejectionEntry[] {
  return [...rs].sort((a, b) => cmp(rejectionSortKey(a), rejectionSortKey(b)));
}

/** The SINGLE manifest function — used by both live replay and stored-outcome audit. */
export function auditReplayOutcomes(
  outcomes: ReplayOutcomeSet,
  mode: ExecutionMode,
  dependencyContext: ReplayDependencyContext
): ReplayManifest {
  const accounts = sortAccounts(outcomes.accounts.map(accountEntry));
  const rejections = sortRejections(outcomes.rejections);
  const accountCount = accounts.length; // DERIVED
  const rejectionCount = rejections.length; // DERIVED
  const manifestDigest = ("replaymanifest:sha256:" +
    sha256Hex(
      canonicalize({
        manifestSchemaVersion: REPLAY_MANIFEST_SCHEMA_VERSION,
        executionMode: mode,
        dependencyContext,
        accounts,
        rejections,
      })
    )) as ReplayManifestDigest;
  return deepFreeze({
    manifestSchemaVersion: REPLAY_MANIFEST_SCHEMA_VERSION,
    executionMode: mode,
    dependencyContext,
    accountCount,
    accounts,
    rejectionCount,
    rejections,
    manifestDigest,
  });
}

/** Accounts-only fingerprint. Never represents rejections; NOT a ReplayManifest. */
export function auditAccountsOnly(
  accounts: readonly CanonicalObservation[]
): AccountAuditManifest {
  const entries = sortAccounts(accounts.map(accountEntry));
  const accountsDigest = ("accounts:sha256:" +
    sha256Hex(
      canonicalize({ manifestSchemaVersion: REPLAY_MANIFEST_SCHEMA_VERSION, accounts: entries })
    )) as AccountsDigest;
  return deepFreeze({
    manifestSchemaVersion: REPLAY_MANIFEST_SCHEMA_VERSION,
    accountCount: entries.length,
    accounts: entries,
    accountsDigest,
  });
}

export function manifestsEqual(a: ReplayManifest, b: ReplayManifest): boolean {
  return a.manifestDigest === b.manifestDigest;
}

function accountSetsBySource(
  entries: readonly ReplayManifestEntry[]
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = m.get(e.sourceObservationId) ?? new Set<string>();
    set.add(e.observationAccountId);
    m.set(e.sourceObservationId, set);
  }
  return m;
}

/** Structured, machine-checkable comparison — never a string. */
export function compareManifests(
  actual: ReplayManifest,
  expected: ReplayManifest
): ReplayComparisonResult {
  const actualIds = new Set(actual.accounts.map((e) => e.observationAccountId));
  const expectedIds = new Set(expected.accounts.map((e) => e.observationAccountId));
  const missingAccounts = expected.accounts
    .map((e) => e.observationAccountId)
    .filter((id) => !actualIds.has(id));
  const unexpectedAccounts = actual.accounts
    .map((e) => e.observationAccountId)
    .filter((id) => !expectedIds.has(id));

  const expBySource = accountSetsBySource(expected.accounts);
  const actBySource = accountSetsBySource(actual.accounts);
  type ChangedEntry = ReplayDivergence["changedBySource"][number];
  const changedBySource: ChangedEntry[] = [];
  for (const source of new Set([...expBySource.keys(), ...actBySource.keys()])) {
    const exp = expBySource.get(source) ?? new Set<string>();
    const act = actBySource.get(source) ?? new Set<string>();
    const sameSet = exp.size === act.size && [...exp].every((x) => act.has(x));
    if (!sameSet) {
      changedBySource.push({
        sourceObservationId: source as ChangedEntry["sourceObservationId"],
        expected: [...exp].find((x) => !act.has(x)) as ChangedEntry["expected"],
        actual: [...act].find((x) => !exp.has(x)) as ChangedEntry["actual"],
      });
    }
  }

  const rejKey = (r: ReplayRejectionEntry): string =>
    canonicalize({ sourceRef: r.sourceRef, identityDigest: r.identityDigest });
  const actualRej = new Map(actual.rejections.map((r) => [rejKey(r), r]));
  const expectedRej = new Map(expected.rejections.map((r) => [rejKey(r), r]));
  const missingRejections = expected.rejections.filter((r) => !actualRej.has(rejKey(r)));
  const unexpectedRejections = actual.rejections.filter((r) => !expectedRej.has(rejKey(r)));

  const clean =
    missingAccounts.length === 0 &&
    unexpectedAccounts.length === 0 &&
    changedBySource.length === 0 &&
    missingRejections.length === 0 &&
    unexpectedRejections.length === 0;

  if (clean) return { ok: true };
  return {
    ok: false,
    reason: "REPLAY_MANIFEST_DIVERGENCE",
    divergence: {
      missingAccounts,
      unexpectedAccounts,
      changedBySource,
      missingRejections,
      unexpectedRejections,
    },
  };
}
