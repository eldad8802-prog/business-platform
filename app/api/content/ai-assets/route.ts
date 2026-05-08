import { generateAiAssets } from "@/lib/services/ai-asset-generation.service";
import { getCurrentUser } from "@/lib/auth";

type ContentFlow = {
  mode?: "ai" | "camera" | "voice";
  goal?: "leads" | "trust" | "exposure" | "sales";
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
};

type ContentResult = {
  selectedVariant?: {
    script?: {
      scriptText?: string;
      caption?: string;
      shots?: { visual: string; voice: string }[];
    };
  };
};

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      flow?: ContentFlow;
      result?: ContentResult;
    };

    const flow = body.flow;
    const result = body.result;

    if (!flow || !result) {
      return Response.json(
        { error: "missing_payload" },
        { status: 400 }
      );
    }

    if (flow.mode !== "ai") {
      return Response.json(
        { error: "invalid_mode" },
        { status: 400 }
      );
    }

    const script = result.selectedVariant?.script;
    const shots = script?.shots ?? [];

    if (!flow.selectedFormat || !flow.selectedPlatform) {
      return Response.json(
        { error: "missing_flow_data" },
        { status: 400 }
      );
    }

    if (!script?.scriptText || shots.length === 0) {
      return Response.json(
        { error: "missing_script_data" },
        { status: 400 }
      );
    }

    const assets = await generateAiAssets({
      flow,
      result,
    });

    return Response.json({
      success: true,
      assets,
      source: "ai",
    });
  } catch (err) {
    console.error(err);

    return Response.json(
      { error: "failed_to_generate_ai_assets" },
      { status: 500 }
    );
  }
}