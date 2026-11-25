import { randomUUID } from "node:crypto";
import { QuotaExhaustedError, quotaExhaustedBody, requireUsage, settleUsage } from "@/lib/services/subscriptions/usage/usage-meter";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getServerI18n } from "@/lib/i18n/server";
import { createCreatomateRender } from "@/lib/services/creatomate.service";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import { getCurrentUser } from "@/lib/auth";
import { isSubstantiveContentGoalBrief } from "@/lib/content/content-goal-prompt-normalize";
import { normalizeAssetUrlsForCreatomate } from "@/lib/services/storage/public-asset-storage.service";

type ContentFlow = {
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
  contentGoalPrompt?: string;
};

type SelectedVariant = {
  id?: string;
  title?: string;
  description?: string;
  whyItFits?: string;
  score?: number;
  tone?: string;
  pace?: string;
  videoType?: "SHORT" | "MID" | "FULL";
  durationSeconds?: number;
  structure?: string[];
  script?: {
    title?: string;
    hook?: string;
    scriptText?: string;
    caption?: string;
    shots?: { visual: string; voice: string }[];
  };
  shotRequests?: {
    index: number;
    purpose: string;
    visualPrompt: string;
    shootingGuidance: string;
  }[];
  assetsPlan?: {
    requiredAssets: string[];
    optionalAssets: string[];
  };
  renderBlueprint?: RenderBlueprint;
};

type ContentResult = {
  selectedVariant?: SelectedVariant;
};

export async function POST(req: Request) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.CONTENT);
  if (featureDenied) return featureDenied;
  const { t } = await getServerI18n();
  const user = await getCurrentUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let renderUnit: string | null = null;
  try {
    const businessId = user.businessId;
    // Subscriptions stage C (decision 29): the central quota replaces the legacy weekly counter (Usage table, kept
    // as it is — its rows are not touched). video_renders is 0 on every plan until the cost is verified (decision 23):
    // in ENFORCE a customer is refused here, before Creatomate is called.
    // (reserved right before the provider call below, after every validation)

    const body = (await req.json()) as {
      flow?: ContentFlow;
      result?: ContentResult;
      assets?: Record<string, string>;
    };

    const flow = body.flow;
    const result = body.result;
    const assetsMap = body.assets || {};

    const selectedVariant = result?.selectedVariant;
    const script = selectedVariant?.script;
    const shots = script?.shots || [];
    const assetUrls = normalizeAssetUrlsForCreatomate(
      Object.values(assetsMap).filter(Boolean)
    );

    console.log("RENDER INPUT FLOW:", flow);
    console.log("RENDER INPUT VARIANT:", {
      id: selectedVariant?.id,
      title: selectedVariant?.title,
      videoType: selectedVariant?.videoType,
      durationSeconds: selectedVariant?.durationSeconds,
      structure: selectedVariant?.structure,
    });
    console.log("RENDER INPUT SHOTS COUNT:", shots.length);
    console.log("RENDER INPUT ASSET URLS:", assetUrls);

    if (!flow?.selectedFormat || !flow?.selectedPlatform) {
      return Response.json(
        {
          error: "missing_flow_data",
          message: "selectedFormat or selectedPlatform is missing",
        },
        { status: 400 }
      );
    }

    if (!isSubstantiveContentGoalBrief(flow.contentGoalPrompt)) {
      return Response.json(
        {
          error: "brief_required",
          message: t("api.content.renderBriefRequired"),
        },
        { status: 400 }
      );
    }

    if (!selectedVariant) {
      return Response.json(
        {
          error: "missing_selected_variant",
          message: "selectedVariant is missing",
        },
        { status: 400 }
      );
    }

    if (!script?.scriptText) {
      return Response.json(
        {
          error: "missing_script_text",
          message: "selectedVariant.script.scriptText is missing",
        },
        { status: 400 }
      );
    }

    if (!shots.length) {
      return Response.json(
        {
          error: "missing_shots",
          message: "selectedVariant.script.shots is missing",
        },
        { status: 400 }
      );
    }

    if (!assetUrls.length) {
      return Response.json(
        {
          error: "missing_assets",
          message: "assets are missing",
        },
        { status: 400 }
      );
    }

    renderUnit = `render:${randomUUID()}`;
    await requireUsage({ businessId, metric: "video_renders", unitKey: renderUnit, source: "content.render", reserve: true });
    const render = await createCreatomateRender({
      assets: assetUrls,
      shots,
      scriptText: script.scriptText,
      caption: script.caption,
      selectedFormat: flow.selectedFormat,
      selectedPlatform: flow.selectedPlatform,
      renderBlueprint: selectedVariant.renderBlueprint,
    });

    console.log("CREATE RENDER RESULT:", render);

    await settleUsage({ businessId, metric: "video_renders", unitKey: renderUnit, state: "COUNTED" });

    return Response.json({
      success: true,
      renderId: render.id,
      status: render.status,
      url: render.url ?? null,
      snapshotUrl: render.snapshot_url ?? null,
    });
  } catch (err) {
    if (err instanceof QuotaExhaustedError) {
      return Response.json(quotaExhaustedBody(err.decision), { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    // The render did not start: the reserved unit is UNKNOWN (the provider may have accepted it) — kept, reconciled.
    if (renderUnit) await settleUsage({ businessId: user.businessId, metric: "video_renders", unitKey: renderUnit, state: "UNKNOWN" });
    console.error("FAILED TO START RENDER:", err);

    return Response.json(
      {
        error: "failed_to_start_render",
        message: err instanceof Error ? err.message : "Unknown render error",
      },
      { status: 500 }
    );
  }
}