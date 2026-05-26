import { orchestrateAiVisualAssets } from "@/lib/features/visual-generation";

type SelectedFormat = "reel" | "video" | "image" | "post";
type SelectedPlatform = "instagram" | "tiktok" | "facebook";

type ContentFlow = {
  mode?: "ai" | "camera" | "voice";
  goal?: "leads" | "trust" | "exposure" | "sales";
  selectedFormat?: SelectedFormat;
  selectedPlatform?: SelectedPlatform;
};

type Shot = {
  visual: string;
  voice: string;
};

type ContentResult = {
  selectedVariant?: {
    script?: {
      scriptText?: string;
      caption?: string;
      shots?: Shot[];
    };
  };
};

type GenerateAiAssetsInput = {
  flow: ContentFlow;
  result: ContentResult;
};

export async function generateAiAssets(
  input: GenerateAiAssetsInput
): Promise<Record<string, string>> {
  const { flow, result } = input;

  if (flow.mode !== "ai") {
    throw new Error("AI assets can only be generated for ai mode");
  }

  if (!flow.selectedFormat || !flow.selectedPlatform) {
    throw new Error("Missing selected format or selected platform");
  }

  const script = result.selectedVariant?.script;
  const shots = script?.shots ?? [];

  if (!script?.scriptText || shots.length === 0) {
    throw new Error("Missing script data for AI assets");
  }

  const { assets } = await orchestrateAiVisualAssets({
    flow,
    shots,
  });

  return assets;
}
