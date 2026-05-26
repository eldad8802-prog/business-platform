/** Extend when wiring Runway / Pika / Sora-style / image-motion providers. */
export type VisualProviderId =
  | "pexels_stock"
  | "legacy_pool"
  | "runway_video"
  | "pika_video"
  | "sora_style_video"
  | "image_motion";

export type VisualSourceType = "stock" | "fallback_pool";

/** Why we did not use primary stock retrieval (for metering / caps later). */
export type VisualFallbackReason =
  | null
  | "stock_disabled"
  | "no_api_key"
  | "no_results"
  | "http_error"
  | "rate_limited"
  | "invalid_response"
  | "exception"
  /** Same search page had hits but every candidate URL was already used in this generation. */
  | "pexels_all_used";

export type ContentFlowSnapshot = {
  mode?: "ai" | "camera" | "voice";
  goal?: "leads" | "trust" | "exposure" | "sales";
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
};

export type ShotSnapshot = {
  visual: string;
  voice: string;
};

export type VisualOrchestratorInput = {
  flow: ContentFlowSnapshot;
  shots: ShotSnapshot[];
};

export type ShotVisualResolution = {
  shotIndex: number;
  videoUrl: string;
  providerId: VisualProviderId;
  sourceType: VisualSourceType;
  fallbackReason: VisualFallbackReason;
  /** Stock search query when stock path was attempted */
  stockQuery?: string;
};

export type VisualOrchestratorResult = {
  assets: Record<string, string>;
  resolutions: ShotVisualResolution[];
};
