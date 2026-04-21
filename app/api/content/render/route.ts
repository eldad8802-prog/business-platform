import { checkUsage, incrementUsage } from "@/lib/services/usage.service";
import { createCreatomateRender } from "@/lib/services/creatomate.service";

type ContentFlow = {
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
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
};

type ContentResult = {
  selectedVariant?: SelectedVariant;
};

export async function POST(req: Request) {
  try {
    const businessId = 1;
    const plan = "FREE" as const;

    const usage = await checkUsage(businessId, plan);
    console.log("RENDER USAGE CHECK:", usage);

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
    const assetUrls = Object.values(assetsMap).filter(Boolean);

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

    const render = await createCreatomateRender({
      assets: assetUrls,
      shots,
      scriptText: script.scriptText,
      caption: script.caption,
      selectedFormat: flow.selectedFormat,
      selectedPlatform: flow.selectedPlatform,
    });

    console.log("CREATE RENDER RESULT:", render);

    await incrementUsage(businessId);

    return Response.json({
      success: true,
      renderId: render.id,
      status: render.status,
      url: render.url ?? null,
      snapshotUrl: render.snapshot_url ?? null,
    });
  } catch (err) {
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