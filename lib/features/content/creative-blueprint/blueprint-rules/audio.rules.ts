import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { Mode } from "@/lib/features/content/decision";
import type {
  NarrationStrategy,
  NarrationTone,
  SoundtrackStrategy,
  SoundtrackGenre,
} from "../types";

export function resolveNarrationStrategy(
  profile: BusinessContentProfile,
  mode?: Mode
): NarrationStrategy {
  // mode=camera → user is on screen, speaking directly
  if (mode === "camera") return "on_camera";

  // mode=voice → narration over visuals
  if (mode === "voice") return "voiceover";

  // AI mode: decide based on visual strength and content style
  const { visualStrength, contentStyle, marketCategory } = profile;

  // Low visual strength → voice must carry the content, visuals can't
  if (visualStrength === "low") return "voiceover";

  // Demonstration / transformation with high visuals → let visuals speak
  // but keep subtle voice for guidance
  if (
    (contentStyle === "demonstration" || contentStyle === "transformation") &&
    visualStrength === "high"
  ) {
    return "hybrid";
  }

  // Authority / explanation → voice delivers the credibility
  if (contentStyle === "authority" || contentStyle === "explanation") {
    return "voiceover";
  }

  // Tech / SaaS → screen recording needs narration or text
  if (marketCategory === "technology") return "voiceover";

  // Default: hybrid gives flexibility
  return "hybrid";
}

export function resolveNarrationTone(
  profile: BusinessContentProfile
): NarrationTone {
  const {
    brandPersona,
    emotionalDriver,
    trustLevel,
    marketCategory,
    contentStyle,
    salesCycle,
  } = profile;

  // Luxury / premium → authoritative, not pushy
  if (brandPersona === "luxury" || brandPersona === "premium") {
    return "authoritative";
  }

  // Personal brands → warmth first (therapy, coaching, personal trainers)
  // Checked before authority rule so personal-brand businesses stay warm.
  if (brandPersona === "personal") return "warm";

  // Authority content style (legal, finance, consulting, medical with professional brand)
  // OR high-trust professional services with medium/long sales cycle:
  // these must project credibility — authoritative tone, not warmth.
  // Excluded: friendly and energetic personas whose warmth/energy is a brand asset.
  if (
    (contentStyle === "authority" ||
      (trustLevel === "high" &&
        (salesCycle === "medium" || salesCycle === "long"))) &&
    brandPersona !== "friendly" &&
    brandPersona !== "energetic"
  ) {
    return "authoritative";
  }

  // Health / therapy / coaching → intimacy and safety
  if (
    emotionalDriver === "trust" ||
    emotionalDriver === "security" ||
    marketCategory === "health"
  ) {
    return "warm";
  }

  // Pain driver → intimate, empathetic, close
  if (emotionalDriver === "pain") return "intimate";

  // Energetic brand → confident and direct
  if (brandPersona === "energetic") return "confident";

  // Friendly brand → warm
  if (brandPersona === "friendly") return "warm";

  return "confident";
}

export function resolveSoundtrackStrategy(
  profile: BusinessContentProfile,
  mode?: Mode
): SoundtrackStrategy {
  const { brandPersona, marketCategory, contentStyle, salesCycle, emotionalDriver } =
    profile;

  // Finance / legal → silence or barely-there soundtrack
  if (marketCategory === "finance" || marketCategory === "legal") return "subtle";

  // Camera mode + personal brand → subtle background only, voice leads
  if (mode === "camera" && brandPersona === "personal") return "subtle";

  // Luxury → no distracting music, let visuals breathe
  if (brandPersona === "luxury") return "emotional";

  // Instant sales cycle + offer content → energetic to drive urgency
  if (salesCycle === "instant" && contentStyle === "offer") return "energetic";

  // Beauty / travel / events with desire driver → emotional pull
  if (
    (marketCategory === "beauty" ||
      marketCategory === "events" ||
      marketCategory === "services") &&
    emotionalDriver === "desire"
  ) {
    return "emotional";
  }

  // Energetic persona → energetic soundtrack
  if (brandPersona === "energetic") return "energetic";

  return "subtle";
}

export function resolveSoundtrackGenre(
  profile: BusinessContentProfile
): SoundtrackGenre {
  const { brandPersona, marketCategory, emotionalDriver } = profile;

  if (brandPersona === "luxury") return "calm";

  if (brandPersona === "energetic") return "energetic";

  if (
    emotionalDriver === "desire" &&
    (marketCategory === "beauty" ||
      marketCategory === "food" ||
      marketCategory === "events")
  ) {
    return "emotional";
  }

  if (
    marketCategory === "finance" ||
    marketCategory === "legal" ||
    marketCategory === "technology"
  ) {
    return "corporate";
  }

  if (
    marketCategory === "home" ||
    marketCategory === "health" ||
    brandPersona === "personal" ||
    brandPersona === "friendly"
  ) {
    return "local";
  }

  if (emotionalDriver === "security" || emotionalDriver === "trust") {
    return "calm";
  }

  return "corporate";
}
