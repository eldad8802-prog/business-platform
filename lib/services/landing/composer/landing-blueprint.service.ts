import { createHash } from "node:crypto";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { getLandingBusinessContext, type LandingBusinessContext } from "../landing-business-context";
import { buildLandingStrategySet } from "../landing-strategy-engine";
import { buildComposerContext } from "./composer-context";
import { composeBlueprint, type ComposerModel, type CompositionResult } from "./landing-composer";

/**
 * P3-C · Server entry point for composing a blueprint for the SESSION business.
 *
 * The client supplies ONLY a strategy id the server issued. The strategy set is recomputed here, inside
 * this business's tenant transaction (the identity loader pins the tenant first), and the id must match
 * one of the CURRENT strategies — a stale, foreign or forged id (or any client-built strategy object)
 * cannot be composed. Nothing is persisted: the blueprint is a MACHINE_PROPOSAL.
 *
 * Duplicate-call control (no persistence exists for this, by design):
 *   - identical in-flight requests (double click, React double effect, client retry) share ONE model call
 *     (single-flight, keyed by business × strategy id × a fingerprint of the composer context);
 *   - a COMPOSED result is reused for a short window for the same key;
 *   - the LANDING_COMPOSE rate-limit bucket (route) bounds spend per user / business / globally.
 * Limitation: single-flight and the reuse window are per server instance (multi-instance duplicates are
 * bounded by the rate limiter, not deduplicated).
 */

export class LandingStrategyNotAvailableError extends Error {
  constructor() {
    super("This strategy is not one of the business's current strategies");
    this.name = "LandingStrategyNotAvailableError";
  }
}

export const STRATEGY_ID_PATTERN = /^p3b\.strategy\.v\d+:[A-Z_]+:[A-Z_]+(?::[A-Z_]+)?$/;
const REUSE_MS = 2 * 60_000;

const inflight = new Map<string, Promise<CompositionResult>>();
const recent = new Map<string, { at: number; result: CompositionResult }>();

export function resetComposerCacheForTests(): void {
  inflight.clear();
  recent.clear();
}

function fingerprint(landing: LandingBusinessContext, strategyId: string, composerCtx: unknown): string {
  return createHash("sha256").update(`${landing.businessId}|${strategyId}|${JSON.stringify(composerCtx)}`).digest("hex").slice(0, 32);
}

function logResult(businessId: number, r: CompositionResult) {
  // Codes, versions, counts and timings only — never prompt or output text, never refs' content.
  console.info(
    `[landing-composer] RESULT business=${businessId} strategy=${r.meta.strategyId} status=${r.compositionStatus} valid=${r.blueprintValid}` +
      ` attempts=${r.attempts} repair=${r.repairUsed} reason=${r.failureReason ?? "-"} violations=${[...new Set(r.violations.map((v) => v.code))].join(",") || "-"}` +
      ` composer=${r.meta.composerVersion} prompt=${r.meta.promptVersion} model=${r.meta.provider}/${r.meta.model}` +
      ` latencyMs=${r.meta.latencyMs} inTok=${r.meta.inputTokens ?? "-"} outTok=${r.meta.outputTokens ?? "-"}`,
  );
}

export async function composeLandingBlueprintForBusiness(
  businessId: number,
  strategyId: unknown,
  deps: { model: ComposerModel | null; now?: Date },
): Promise<CompositionResult> {
  if (typeof strategyId !== "string" || strategyId.length > 200 || !STRATEGY_ID_PATTERN.test(strategyId)) throw new LandingStrategyNotAvailableError();
  // Recompute inside the session business's tenant transaction (read-only work; no model call held open).
  const landing = await tenantTx(businessId, (tx) => getLandingBusinessContext(businessId, tx, deps.now));
  const strategy = buildLandingStrategySet(landing).strategies.find((s) => s.id === strategyId);
  if (!strategy || landing.businessId !== businessId) throw new LandingStrategyNotAvailableError();

  const key = fingerprint(landing, strategyId, buildComposerContext(landing, strategy));
  const cached = recent.get(key);
  if (cached && Date.now() - cached.at < REUSE_MS) return cached.result;
  const running = inflight.get(key);
  if (running) return running;

  const job = composeBlueprint({ landing, strategy, model: deps.model })
    .then((result) => {
      logResult(businessId, result);
      if (result.compositionStatus === "COMPOSED") recent.set(key, { at: Date.now(), result });
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
