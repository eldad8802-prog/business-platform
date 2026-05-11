import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { Mode, SelectedPlatform } from "@/lib/features/content/decision";
import type {
  VisualStrategy,
  VisualEnergy,
  VisualIdentity,
} from "../types";

export function resolveVisualStrategy(
  profile: BusinessContentProfile,
  mode?: Mode
): VisualStrategy {
  // Camera mode always means user films themselves — no stock, no AI
  if (mode === "camera") return "local_authentic";

  const { visualStrength, brandPersona, marketCategory, contentStyle } = profile;

  // Luxury persona → sparse, cinematic, controlled
  if (brandPersona === "luxury" && visualStrength === "high") return "luxury_minimal";

  // Tech / SaaS / Education with low visuals → type-driven or screen-based
  if (marketCategory === "technology" || marketCategory === "other") {
    if (visualStrength === "low") return "ui_visuals";
    if (visualStrength === "medium") return "motion_graphics";
  }

  // Finance / Legal / Insurance → trust through text, not visuals
  if (
    (marketCategory === "finance" || marketCategory === "legal") &&
    visualStrength === "low"
  ) {
    return "typography_heavy";
  }

  // Education: explanation-style with medium visuals → motion graphics
  if (marketCategory === "education" && contentStyle === "explanation") {
    return "motion_graphics";
  }

  // High visual strength + demonstrative / transformation → stock or hybrid
  if (visualStrength === "high") {
    if (
      contentStyle === "demonstration" ||
      contentStyle === "transformation" ||
      contentStyle === "testimonial"
    ) {
      return "stock_footage";
    }
  }

  // Personal / friendly brands filming locally → hybrid leans authentic
  if (brandPersona === "personal" || brandPersona === "friendly") {
    return "hybrid";
  }

  // Medium visual strength default
  if (visualStrength === "medium") return "hybrid";

  // Low visual strength default → let text carry
  if (visualStrength === "low") return "typography_heavy";

  return "hybrid";
}

export function resolveVisualEnergy(
  profile: BusinessContentProfile,
  selectedPlatform?: SelectedPlatform
): VisualEnergy {
  const { emotionalDriver, brandPersona, salesCycle } = profile;

  // TikTok + instant sales cycle → maximum energy
  if (selectedPlatform === "tiktok" && salesCycle === "instant") return "high";

  // Energetic brand persona
  if (brandPersona === "energetic") return "high";

  // Desire/status driver with non-professional persona
  if (
    (emotionalDriver === "desire" || emotionalDriver === "status") &&
    brandPersona !== "professional"
  ) {
    return "high";
  }

  // Luxury / premium → composed and deliberate
  if (brandPersona === "luxury" || brandPersona === "premium") return "calm";

  // Security / trust / pain drivers → calm and reassuring
  if (
    emotionalDriver === "security" ||
    emotionalDriver === "trust" ||
    emotionalDriver === "pain"
  ) {
    return "calm";
  }

  return "medium";
}

export function resolveVisualIdentity(
  profile: BusinessContentProfile
): VisualIdentity {
  const { marketCategory, brandPersona, emotionalDriver, contentStyle } = profile;

  // Color mood
  let colorMood: VisualIdentity["colorMood"];
  if (brandPersona === "luxury" || marketCategory === "events") {
    colorMood = "monochrome";
  } else if (
    marketCategory === "beauty" ||
    marketCategory === "food" ||
    emotionalDriver === "desire"
  ) {
    colorMood = "warm";
  } else if (marketCategory === "technology" || marketCategory === "finance") {
    colorMood = "cool";
  } else if (brandPersona === "energetic") {
    colorMood = "bold";
  } else {
    colorMood = "neutral";
  }

  // Lighting style
  let lightingStyle: VisualIdentity["lightingStyle"];
  if (brandPersona === "luxury" || brandPersona === "premium") {
    lightingStyle = "moody_dramatic";
  } else if (
    marketCategory === "beauty" ||
    marketCategory === "food" ||
    marketCategory === "health"
  ) {
    lightingStyle = "bright_airy";
  } else if (marketCategory === "technology" || marketCategory === "education") {
    lightingStyle = "clean_studio";
  } else if (brandPersona === "personal" || brandPersona === "friendly") {
    lightingStyle = "natural";
  } else {
    lightingStyle = "minimal";
  }

  // Composition style
  let compositionStyle: VisualIdentity["compositionStyle"];
  if (contentStyle === "transformation" || contentStyle === "demonstration") {
    compositionStyle = "dynamic_cuts";
  } else if (
    contentStyle === "authority" ||
    contentStyle === "testimonial"
  ) {
    compositionStyle = "documentary";
  } else if (brandPersona === "luxury" || brandPersona === "premium") {
    compositionStyle = "steady_beauty";
  } else if (
    marketCategory === "technology" ||
    marketCategory === "finance" ||
    marketCategory === "education"
  ) {
    compositionStyle = "graphic";
  } else if (brandPersona === "personal") {
    compositionStyle = "intimate";
  } else {
    compositionStyle = "dynamic_cuts";
  }

  return { colorMood, lightingStyle, compositionStyle };
}
