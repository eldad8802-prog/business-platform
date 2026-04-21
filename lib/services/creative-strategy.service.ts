import { CreatorContextProfile } from "./creator-context-interpreter.service";

export type CreativeContentPillar =
  | "desire"
  | "education"
  | "trust"
  | "result"
  | "pain";

export type CreativeAngle =
  | "visual_craving"
  | "process_reveal"
  | "before_after"
  | "direct_talk"
  | "problem_solution"
  | "authority"
  | "behind_the_scenes";

export type CreativeExecutionStyle =
  | "fast_visual"
  | "talking_head"
  | "voiceover"
  | "hands_process"
  | "result_showcase";

export type CreativePrimaryVisual =
  | "face"
  | "hands"
  | "product"
  | "result"
  | "place";

export type CreativeHookStyle =
  | "curiosity"
  | "desire"
  | "problem"
  | "surprise"
  | "direct";

export type CreativeTrustMechanism =
  | "experience"
  | "process"
  | "result"
  | "social_proof"
  | "none";

export type CreativeCtaStyle = "message" | "follow" | "watch" | "buy";

export type CreativeStrategy = {
  contentPillar: CreativeContentPillar;
  creativeAngle: CreativeAngle;
  executionStyle: CreativeExecutionStyle;
  primaryVisual: CreativePrimaryVisual;
  hookStyle: CreativeHookStyle;
  trustMechanism: CreativeTrustMechanism;
  ctaStyle: CreativeCtaStyle;
};

type Input = {
  goal: "leads" | "trust" | "exposure" | "sales";
  intent: "message" | "follow" | "watch" | "sale";
  businessCategory: string;
  serviceLabel: string;
  creatorProfile: CreatorContextProfile;
  mode: string;
};

function isFood(category: string, service: string) {
  const text = `${category} ${service}`.toLowerCase();

  return ["food", "restaurant", "אוכל", "מסעדה", "מטבח"].some((keyword) =>
    text.includes(keyword)
  );
}

function decideContentPillar(input: Input, isFoodBusiness: boolean): CreativeContentPillar {
  if (isFoodBusiness) {
    return "desire";
  }

  if (input.goal === "trust") {
    return "trust";
  }

  if (input.goal === "sales") {
    return "result";
  }

  if (input.creatorProfile.contentFocus.includes("self_talking")) {
    return "education";
  }

  if (input.creatorProfile.constraints.includes("short_content_only")) {
    return "pain";
  }

  return "result";
}

function decideCreativeAngle(
  input: Input,
  isFoodBusiness: boolean
): CreativeAngle {
  if (isFoodBusiness) {
    return "visual_craving";
  }

  if (input.creatorProfile.contentFocus.includes("process")) {
    return "process_reveal";
  }

  if (input.creatorProfile.contentFocus.includes("final_result")) {
    return "before_after";
  }

  if (input.creatorProfile.contentFocus.includes("self_talking")) {
    return "direct_talk";
  }

  if (input.goal === "trust") {
    return "authority";
  }

  if (input.goal === "sales") {
    return "problem_solution";
  }

  return "behind_the_scenes";
}

function decideExecutionStyle(input: Input): CreativeExecutionStyle {
  if (input.creatorProfile.productionPreference.includes("prefers_voiceover")) {
    return "voiceover";
  }

  if (input.creatorProfile.productionPreference.includes("easy_and_fast")) {
    return "fast_visual";
  }

  if (input.creatorProfile.contentFocus.includes("self_talking")) {
    return "talking_head";
  }

  if (input.creatorProfile.contentFocus.includes("process")) {
    return "hands_process";
  }

  return "result_showcase";
}

function decidePrimaryVisual(
  input: Input,
  isFoodBusiness: boolean
): CreativePrimaryVisual {
  if (isFoodBusiness) {
    return "hands";
  }

  if (input.creatorProfile.productionPreference.includes("prefers_no_face")) {
    return "hands";
  }

  if (input.creatorProfile.contentFocus.includes("self_talking")) {
    return "face";
  }

  if (input.creatorProfile.contentFocus.includes("final_result")) {
    return "result";
  }

  if (input.creatorProfile.contentFocus.includes("place_or_space")) {
    return "place";
  }

  return "product";
}

function decideHookStyle(contentPillar: CreativeContentPillar): CreativeHookStyle {
  switch (contentPillar) {
    case "desire":
      return "desire";
    case "education":
      return "curiosity";
    case "pain":
      return "problem";
    case "trust":
      return "direct";
    case "result":
    default:
      return "surprise";
  }
}

function decideTrustMechanism(
  contentPillar: CreativeContentPillar,
  creativeAngle: CreativeAngle
): CreativeTrustMechanism {
  if (creativeAngle === "process_reveal") {
    return "process";
  }

  if (creativeAngle === "before_after") {
    return "result";
  }

  if (contentPillar === "trust") {
    return "experience";
  }

  if (contentPillar === "education") {
    return "social_proof";
  }

  return "none";
}

function decideCtaStyle(intent: Input["intent"]): CreativeCtaStyle {
  switch (intent) {
    case "message":
      return "message";
    case "follow":
      return "follow";
    case "sale":
      return "buy";
    case "watch":
    default:
      return "watch";
  }
}

export function runCreativeStrategyEngine(input: Input): CreativeStrategy {
  const isFoodBusiness = isFood(input.businessCategory, input.serviceLabel);

  const contentPillar = decideContentPillar(input, isFoodBusiness);
  const creativeAngle = decideCreativeAngle(input, isFoodBusiness);
  const executionStyle = decideExecutionStyle(input);
  const primaryVisual = decidePrimaryVisual(input, isFoodBusiness);
  const hookStyle = decideHookStyle(contentPillar);
  const trustMechanism = decideTrustMechanism(contentPillar, creativeAngle);
  const ctaStyle = decideCtaStyle(input.intent);

  return {
    contentPillar,
    creativeAngle,
    executionStyle,
    primaryVisual,
    hookStyle,
    trustMechanism,
    ctaStyle,
  };
}