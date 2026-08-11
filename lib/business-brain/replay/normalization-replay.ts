/**
 * Father Engine — C0 / PR4. Normalization Replay path.
 *
 * produceNormalizationReplay: Raw fixtures → normalize → ReplayOutcomeSet → (if
 * pinning holds) a ReplayManifest. It NEVER invokes inference — normalize only
 * consumes already-frozen RawInput.inference. A manifest is not built when pinning
 * fails.
 *
 * runHistoricalReplay: a two-step convenience — produce, then compare against an
 * expected baseline. The harness never claims divergence without a baseline.
 */

import { normalize, type NormalizeDeps } from "../normalization/normalize";
import type { NormalizationResult } from "../normalization/normalization-result.types";
import type { RawInput } from "../normalization/translator.interface";
import type { CanonicalObservation } from "../observation.types";
import { verifyPinning, type ReplayDeps } from "./registry-pinning";
import {
  auditReplayOutcomes,
  compareManifests,
  toRejectionEntry,
} from "./replay-manifest";
import type {
  ExecutionMode,
  ReplayComparisonResult,
  ReplayManifest,
  ReplayOutcomeSet,
  ReplayRun,
} from "./replay.types";

type OkResult = Extract<NormalizationResult, { ok: true }>;
type FailResult = Extract<NormalizationResult, { ok: false }>;
const isOk = (r: NormalizationResult): r is OkResult => r.ok;
const isFail = (r: NormalizationResult): r is FailResult => !r.ok;

function toNormalizeDeps(deps: ReplayDeps): NormalizeDeps {
  return {
    translator: deps.translator,
    conceptRegistry: deps.conceptRegistry,
    coverageRegistry: deps.coverageRegistry,
    realityTierValidator: deps.realityTierValidator,
    context: deps.context,
  };
}

export function produceNormalizationReplay(
  rawInputs: readonly RawInput[],
  deps: ReplayDeps,
  mode: ExecutionMode
): ReplayRun {
  const pinning = verifyPinning(deps);
  const normalizeDeps = toNormalizeDeps(deps);

  const results: NormalizationResult[] = [];
  for (const input of rawInputs) {
    for (const r of normalize(input, normalizeDeps)) results.push(r);
  }

  const accounts: CanonicalObservation[] = results.filter(isOk).map((r) => r.observation);
  const rejections = results.filter(isFail).map(toRejectionEntry);
  const outcomes: ReplayOutcomeSet = { accounts, rejections };

  const manifest = pinning.ok
    ? auditReplayOutcomes(outcomes, mode, deps.dependencyContext)
    : undefined;

  return { mode, pinning, outcomes, manifest };
}

export function runHistoricalReplay(
  rawInputs: readonly RawInput[],
  deps: ReplayDeps,
  expectedManifest: ReplayManifest
): { run: ReplayRun; comparison: ReplayComparisonResult | null } {
  const run = produceNormalizationReplay(rawInputs, deps, "HISTORICAL_REPLAY");
  const comparison = run.manifest ? compareManifests(run.manifest, expectedManifest) : null;
  return { run, comparison };
}
