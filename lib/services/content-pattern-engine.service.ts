import type { CreativeAngleType } from "./content/creative-angle-engine.service";

type Input = {
  goal: "leads" | "exposure" | "trust" | "sales";
  intent: "watch" | "follow" | "message" | "sale";
  businessCategory: string;
  angleType?: CreativeAngleType;
  forcedPattern?: ContentPattern;
};

export type ContentPattern =
  | "PATTERN_BREAK"
  | "WAIT_FOR_IT"
  | "BEFORE_AFTER"
  | "POV"
  | "MISTAKE"
  | "SECRET"
  | "PROCESS"
  | "RESULT"
  | "REACTION";

function isFoodBusiness(category: string) {
  const value = category.toLowerCase();

  return (
    value.includes("food") ||
    value.includes("restaurant") ||
    value.includes("אוכל") ||
    value.includes("מסעדה")
  );
}

export function pickContentPattern(input: Input): ContentPattern {
  if (input.forcedPattern) {
    return input.forcedPattern;
  }

  const category = input.businessCategory?.toLowerCase() || "";
  const isFood = isFoodBusiness(category);

  if (input.angleType === "mistake") {
    return "MISTAKE";
  }

  if (input.angleType === "secret" || input.angleType === "myth_break") {
    return "SECRET";
  }

  if (input.angleType === "pov") {
    return "POV";
  }

  if (input.angleType === "reaction" || input.angleType === "emotion") {
    return "REACTION";
  }

  if (input.angleType === "comparison") {
    return "BEFORE_AFTER";
  }

  if (input.angleType === "process_truth") {
    return "PROCESS";
  }

  if (input.angleType === "speed") {
    return "RESULT";
  }

  if (input.angleType === "unexpected") {
    return isFood ? "PATTERN_BREAK" : "WAIT_FOR_IT";
  }

  if (input.goal === "exposure") {
    if (isFood) {
      return "PATTERN_BREAK";
    }

    return input.intent === "watch" ? "POV" : "WAIT_FOR_IT";
  }

  if (input.goal === "trust") {
    return input.intent === "follow" ? "PROCESS" : "SECRET";
  }

  if (input.goal === "sales") {
    return input.intent === "sale" ? "RESULT" : "BEFORE_AFTER";
  }

  if (input.goal === "leads") {
    return input.intent === "message" ? "MISTAKE" : "RESULT";
  }

  return "POV";
}