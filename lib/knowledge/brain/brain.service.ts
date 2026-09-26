/**
 * M8 · runBrain — ONE business, ONE snapshot, ONE model call at most. Never writes business data.
 *
 *   1. the server builds the bks.v1 snapshot for this businessId (nothing from the client)
 *   2. the snapshot's businessId must equal the requested one — or nothing proceeds
 *   3. the deterministic context builder minimises and bounds it
 *   4. with no usable knowledge and no findings, the model is NOT called: NOT_ENOUGH_KNOWLEDGE
 *   5. one provider call (bounded, one transient retry inside the adapter)
 *   6. the deterministic validator decides what, if anything, survives
 *
 * Every failure returns a status and a stage, and nothing else changes: deterministic knowledge,
 * business records and every product flow are untouched whatever the model does.
 *
 * Rollout (BRAIN_MODE): "off" never calls a model (kill switch); otherwise "shadow", which only the
 * scheduler route invokes, on explicit request, and which never reaches an owner. Owner-visible modes are not implemented in M8 — surfacing AI
 * insights is an owner decision.
 */
import { BRAIN_CONTRACT_VERSION, type BrainRunMeta, type ValidatedBrainResult } from "./brain.contract";
import { buildBrainContext, CONTEXT_VERSION, stableSerialize } from "./context-builder";
import { BRAIN_PROMPT_VERSION, BRAIN_SYSTEM_PROMPT, brainUserMessage } from "./prompt";
import type { BrainProvider } from "./provider";
import { validateBrainOutput } from "./validator";
import type { BusinessKnowledgeSnapshot } from "../snapshot/snapshot.contract";

export type BrainMode = "off" | "shadow";

/**
 * BRAIN_MODE="off" is the kill switch: no model call anywhere. Anything else permits SHADOW runs, and
 * nothing invokes the Brain automatically — only the scheduler route, when it asks for it explicitly.
 * There is no owner-visible mode in M8.
 */
export function brainMode(): BrainMode {
  return process.env.BRAIN_MODE === "off" ? "off" : "shadow";
}

export type RunBrainOptions = {
  readonly provider: BrainProvider;
  readonly buildSnapshot: (businessId: number) => Promise<BusinessKnowledgeSnapshot>;
  readonly mode: BrainMode;
};

export async function runBrain(businessId: number, opts: RunBrainOptions): Promise<ValidatedBrainResult> {
  const baseMeta = (over: Partial<BrainRunMeta>): BrainRunMeta => ({
    contractVersion: BRAIN_CONTRACT_VERSION, promptVersion: BRAIN_PROMPT_VERSION, contextVersion: CONTEXT_VERSION,
    provider: opts.provider.name, model: opts.provider.model, snapshotFingerprint: "", contextFingerprint: "",
    contextBytes: 0, contextOmitted: {}, modelCalled: false, latencyMs: null, inputTokens: null, outputTokens: null,
    failureStage: null, ...over,
  });
  if (!Number.isInteger(businessId) || businessId <= 0) throw new Error("runBrain: a positive, server-derived businessId is required");

  if (opts.mode === "off") {
    return { businessId, status: "DISABLED", findings: [], rejected: [], meta: baseMeta({ failureStage: "disabled" }) };
  }

  let snapshot: BusinessKnowledgeSnapshot;
  try {
    snapshot = await opts.buildSnapshot(businessId);
  } catch {
    return { businessId, status: "PROVIDER_FAILED", findings: [], rejected: [], meta: baseMeta({ failureStage: "snapshot" }) };
  }
  // One invocation, one tenant: a snapshot for anyone else stops here.
  if (snapshot.businessId !== businessId) {
    return { businessId, status: "INVALID_OUTPUT", findings: [], rejected: [], meta: baseMeta({ failureStage: "snapshot" }) };
  }

  const { context, aliases, fingerprint, bytes } = buildBrainContext(snapshot);
  const meta0 = baseMeta({ snapshotFingerprint: snapshot.snapshotFingerprint, contextFingerprint: fingerprint, contextBytes: bytes, contextOmitted: context.omitted });

  if (context.knowledge.length === 0 && context.findings.length === 0) {
    // Only gaps (or nothing): there is nothing to interpret, and asking a model would invite a guess.
    return { businessId, status: "NOT_ENOUGH_KNOWLEDGE", findings: [], rejected: [], meta: meta0 };
  }

  const response = await opts.provider.complete(BRAIN_SYSTEM_PROMPT, brainUserMessage(stableSerialize(context), fingerprint));
  if (!response.ok) {
    return { businessId, status: "PROVIDER_FAILED", findings: [], rejected: [],
      meta: { ...meta0, modelCalled: response.reason !== "NO_KEY", latencyMs: response.latencyMs, failureStage: "provider" } };
  }
  const meta1: BrainRunMeta = { ...meta0, modelCalled: true, latencyMs: response.latencyMs, inputTokens: response.inputTokens, outputTokens: response.outputTokens };

  const v = validateBrainOutput(response.text, fingerprint, context, aliases, snapshot);
  if (v.kind === "INVALID_OUTPUT") {
    return { businessId, status: "INVALID_OUTPUT", findings: [], rejected: v.rejected,
      meta: { ...meta1, failureStage: v.rejected.some((r) => r.code === "SCHEMA_INVALID") ? "schema" : "grounding" } };
  }
  const status = v.accepted.length > 0 ? "FINDINGS"
    : v.outcome === "NOT_ENOUGH_KNOWLEDGE" ? "NOT_ENOUGH_KNOWLEDGE" : "NO_ACTIONABLE_INSIGHT";
  return { businessId, status, findings: v.accepted, rejected: v.rejected, meta: meta1 };
}
