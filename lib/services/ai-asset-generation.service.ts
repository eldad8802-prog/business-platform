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

const DEFAULT_VIDEO_POOL = [
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
];

function getGoalPool(goal?: ContentFlow["goal"]) {
  switch (goal) {
    case "sales":
      return [
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
      ];

    case "trust":
      return [
        "https://storage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
      ];

    case "exposure":
      return [
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
      ];

    case "leads":
    default:
      return [
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
      ];
  }
}

function getPlatformPool(platform?: SelectedPlatform) {
  switch (platform) {
    case "tiktok":
      return [
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
      ];

    case "facebook":
      return [
        "https://storage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
      ];

    case "instagram":
    default:
      return [
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
        "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
      ];
  }
}

function buildAssetPool(flow: ContentFlow) {
  const goalPool = getGoalPool(flow.goal);
  const platformPool = getPlatformPool(flow.selectedPlatform);

  const merged = [...goalPool, ...platformPool, ...DEFAULT_VIDEO_POOL];

  return Array.from(new Set(merged));
}

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

  const pool = buildAssetPool(flow);

  const assets: Record<string, string> = {};

  for (let i = 0; i < shots.length; i++) {
    assets[String(i)] = pool[i % pool.length];
  }

  return assets;
}