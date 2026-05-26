import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";

export type StoryDensity = "light" | "medium" | "rich";

export type NarrativeBeat = {
  role: string;
  emotionalFunction: string;
  durationSeconds: number;
  retentionDriver: string;
};

export type NarrativeProfile = {
  narrativeBeats: NarrativeBeat[];
  estimatedDurationSeconds: number;
  storyDensity: StoryDensity;
};

export type NarrativeBuildInput = {
  variantBlueprint: CreativeBlueprint;
  businessProfile?: BusinessContentProfile;
  goal: string;
  platform: string;
  style: string;
  resolvedPace: "fast" | "medium" | "slow";
  resolvedHookStyle: string;
  contentAngle?: string;
  fallbackStructure: string[];
  fallbackDurationSeconds: number;
};
