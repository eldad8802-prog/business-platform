type PackagingResult = {
  hookText: string;
  captionLines: string[];
  thumbnailText: string;
  musicType: "calm" | "trendy" | "emotional";
  hashtags: string[];
};

type GenerateFallbackInput = {
  goal: string;
  goalDescription: string;
  intent: string;
  mode: string;
  audienceDescription: string;
  ageRange: string;
  script: string;
  instructions: string[];
  strategy?: string;
  angle?: string;
  tone?: "soft" | "balanced" | "aggressive";
  packaging?: PackagingResult;
};

export async function generateFallback(input: GenerateFallbackInput) {
  const videoUrl =
    "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

  return {
    videoUrl,
    provider: "fallback",
  };
}