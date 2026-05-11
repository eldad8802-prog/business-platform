import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type {
  ContentDecision,
  Goal,
  SelectedPlatform,
  SelectedFormat,
} from "@/lib/features/content/decision";
import type {
  PlatformBehavior,
  SubtitleBehavior,
  CtaPsychology,
} from "../types";

export function resolvePlatformBehavior(
  platform?: SelectedPlatform,
  format?: SelectedFormat
): PlatformBehavior {
  // TikTok: fastest hook window, punchy captions, few hashtags
  if (platform === "tiktok") {
    return {
      hookWindowSeconds: 1.5,
      captionStrategy: "short_punch",
      hashtagCount: 5,
      orientationNote: "אנכי 9:16 בלבד — לא מתפשרים על זה",
    };
  }

  // Facebook: slower consumption, storytelling works, minimal hashtags
  if (platform === "facebook") {
    return {
      hookWindowSeconds: 3.0,
      captionStrategy: "storytelling",
      hashtagCount: 3,
      orientationNote: "אנכי 9:16 מומלץ, ריבועי 1:1 מקובל",
    };
  }

  // Instagram Reels → fast hook, storytelling captions, hashtags matter
  if (platform === "instagram" && format === "reel") {
    return {
      hookWindowSeconds: 2.0,
      captionStrategy: "storytelling",
      hashtagCount: 8,
      orientationNote: "אנכי 9:16 בלבד לרילס",
    };
  }

  // Instagram general (post/video) → keyword-heavy, slower
  if (platform === "instagram") {
    return {
      hookWindowSeconds: 2.5,
      captionStrategy: "keyword_rich",
      hashtagCount: 10,
      orientationNote: "ריבועי 1:1 מומלץ, אנכי נתמך",
    };
  }

  // Default safe fallback
  return {
    hookWindowSeconds: 2.0,
    captionStrategy: "short_punch",
    hashtagCount: 5,
    orientationNote: "אנכי 9:16 מומלץ",
  };
}

export function resolveSubtitleBehavior(
  profile: BusinessContentProfile,
  platform?: SelectedPlatform
): SubtitleBehavior {
  const { brandPersona, visualStrength } = profile;

  // TikTok culture → subtitles always on, accessibility + autoplay sound off
  if (platform === "tiktok") return "always_on";

  // Luxury / premium visuals shouldn't be cluttered with subtitles
  if (brandPersona === "luxury" || brandPersona === "premium") {
    return "key_moments";
  }

  // High visual strength with text-minimal design → minimal subtitles
  // (luxury and premium already returned above, so this catches remaining high-visual cases)
  if (visualStrength === "high") return "minimal";

  // Default: always on — accessibility + most users watch without sound
  return "always_on";
}

export function resolveCtaPsychology(
  profile: BusinessContentProfile,
  decision: ContentDecision,
  goal?: Goal
): CtaPsychology {
  const { salesCycle, trustLevel, emotionalDriver } = profile;
  const ctaStyle = decision.legacyMapping.ctaStyle;

  // CTA style from decision engine drives the psychology
  if (ctaStyle === "buy_now" || ctaStyle === "book_now") {
    // If sales cycle is instant → urgency
    if (salesCycle === "instant") return "urgency";
    // If high trust is required → trust first, then act
    if (trustLevel === "high") return "trust";
  }

  if (ctaStyle === "message_now") {
    // Leads goal → curiosity gap (what happens after the message?)
    if (goal === "leads") return "curiosity";
    // Security driver → trust reassurance
    if (emotionalDriver === "security") return "trust";
  }

  if (ctaStyle === "follow") {
    // Social proof: others follow, you should too
    return "social_proof";
  }

  if (ctaStyle === "learn_more") {
    return "curiosity";
  }

  // Fallback by goal
  if (goal === "sales") return "urgency";
  if (goal === "trust") return "trust";
  if (goal === "exposure") return "social_proof";
  if (goal === "leads") return "curiosity";

  return "trust";
}
