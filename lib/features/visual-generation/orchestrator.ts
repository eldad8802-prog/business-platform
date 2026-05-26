import {
  buildLegacyAssetPool,
  pickLegacyPoolUrl,
} from "./fallback/legacy-asset-pool";
import {
  buildStockSearchQuery,
  MAX_STOCK_QUERY_LEN,
} from "./providers/stock/build-stock-query";
import { fetchPexelsStockVideoUrl } from "./providers/stock/pexels-stock.provider";
import { stockOrientationForFlow } from "./providers/stock/pexels-orientation";
import type {
  ShotVisualResolution,
  VisualFallbackReason,
  VisualOrchestratorInput,
  VisualOrchestratorResult,
} from "./types";

function isStockEnabled(): boolean {
  if (process.env.VISUAL_GEN_STOCK_ENABLED === "false") {
    return false;
  }
  const key = process.env.PEXELS_API_KEY?.trim();
  return Boolean(key && key.length > 5);
}

function getPexelsKey(): string | null {
  const key = process.env.PEXELS_API_KEY?.trim();
  if (!key || key.length < 6) return null;
  return key;
}

function logResolutions(resolutions: ShotVisualResolution[]) {
  if (process.env.VISUAL_GEN_LOG_METRICS !== "true") return;
  try {
    console.info(
      "[visual-gen]",
      JSON.stringify(
        resolutions.map((r) => ({
          i: r.shotIndex,
          provider: r.providerId,
          source: r.sourceType,
          fallback: r.fallbackReason,
          q: r.stockQuery,
        }))
      )
    );
  } catch {
    /* ignore */
  }
}

/**
 * Resolves per-shot video URLs for the AI assets map (Creatomate `type: "video"`).
 * Primary: Pexels stock search from `shot.visual`. Fallback: legacy sample pool.
 */
export async function orchestrateAiVisualAssets(
  input: VisualOrchestratorInput
): Promise<VisualOrchestratorResult> {
  const { flow, shots } = input;
  const pool = buildLegacyAssetPool(flow);
  const resolutions: ShotVisualResolution[] = [];
  const assets: Record<string, string> = {};

  const stockOn = isStockEnabled();
  const apiKey = getPexelsKey();
  const orientation = stockOrientationForFlow(flow);
  const usedPexelsUrls = new Set<string>();
  const usedPexelsVideoIds = new Set<number>();

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const stockQuery = buildStockSearchQuery(shot.visual, flow);

    let videoUrl: string;
    let providerId: ShotVisualResolution["providerId"] = "legacy_pool";
    let sourceType: ShotVisualResolution["sourceType"] = "fallback_pool";
    let fallbackReason: VisualFallbackReason = null;

    if (!stockOn || !apiKey) {
      fallbackReason = !apiKey ? "no_api_key" : "stock_disabled";
      videoUrl = pickLegacyPoolUrl(pool, i);
    } else {
      const tryFetch = async (q: string, page: number) =>
        fetchPexelsStockVideoUrl({
          query: q.slice(0, MAX_STOCK_QUERY_LEN),
          orientation,
          apiKey,
          page,
          excludeUrls: usedPexelsUrls,
          excludeVideoIds: usedPexelsVideoIds,
        });

      let outcome = await tryFetch(stockQuery, 1);

      if (!outcome.ok && outcome.reason === "pexels_all_used") {
        outcome = await tryFetch(stockQuery, 2);
      }

      if (!outcome.ok && outcome.reason === "pexels_all_used") {
        const alt = `${stockQuery} b-roll`
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_STOCK_QUERY_LEN);
        if (alt !== stockQuery.slice(0, MAX_STOCK_QUERY_LEN)) {
          outcome = await tryFetch(alt, 1);
        }
      }

      if (outcome.ok) {
        videoUrl = outcome.url;
        providerId = "pexels_stock";
        sourceType = "stock";
        usedPexelsUrls.add(outcome.url);
        if (outcome.pexelsVideoId > 0) {
          usedPexelsVideoIds.add(outcome.pexelsVideoId);
        }
      } else {
        fallbackReason = outcome.reason;
        videoUrl = pickLegacyPoolUrl(pool, i);
        providerId = "legacy_pool";
        sourceType = "fallback_pool";
      }
    }

    assets[String(i)] = videoUrl;
    resolutions.push({
      shotIndex: i,
      videoUrl,
      providerId,
      sourceType,
      fallbackReason,
      stockQuery,
    });
  }

  logResolutions(resolutions);

  return { assets, resolutions };
}
