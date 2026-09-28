import { generateAiAssets } from "@/lib/services/ai-asset-generation.service";
import { getCurrentUser } from "@/lib/auth";
import {
  BusinessAssetNotFoundError,
  findBusinessAssetByIdempotency,
  recordBusinessAsset,
  requireOwnedContentRun,
} from "@/lib/services/content/business-asset.service";

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
      contentRunId?: number;
    };

    const flow = body.flow;
    const result = body.result;
    const contentRunId =
      Number.isInteger(body.contentRunId) && (body.contentRunId as number) > 0
        ? (body.contentRunId as number)
        : null;

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

    if (contentRunId) {
      await requireOwnedContentRun(user.businessId, contentRunId);
    }

    if (contentRunId) {
      const retained: Record<string, string> = {};
      let complete = true;
      for (let index = 0; index < shots.length; index++) {
        const existing = await findBusinessAssetByIdempotency(
          user.businessId,
          `generated:${contentRunId}:${index}`
        );
        if (!existing?.assetRef || existing.origin !== "GENERATED") {
          complete = false;
          break;
        }
        retained[String(index)] = existing.assetRef;
      }
      if (complete) {
        return Response.json({
          success: true,
          assets: retained,
          source: "ai",
          retained: true,
        });
      }
    }

    const assets = await generateAiAssets({
      flow,
      result,
    });

    for (const [shotKey, url] of Object.entries(assets)) {
      await recordBusinessAsset({
        businessId: user.businessId,
        origin: "GENERATED",
        assetRef: url,
        contentRunId,
        idempotencyKey: contentRunId
          ? `generated:${contentRunId}:${shotKey}`
          : null,
      });
    }

    return Response.json({
      success: true,
      assets,
      source: "ai",
    });
  } catch (err) {
    if (err instanceof BusinessAssetNotFoundError) {
      return Response.json({ error: "Content run not found" }, { status: 404 });
    }
    console.error(err);

    return Response.json(
      { error: "failed_to_generate_ai_assets" },
      { status: 500 }
    );
  }
}