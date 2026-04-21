type Input = {
  goal: "leads" | "exposure" | "trust" | "sales";
  intent: "watch" | "follow" | "message" | "sale";
  businessCategory?: string;
  selectedFormat?: "reel" | "video" | "image" | "post";
  toneOverride?:
    | "direct"
    | "reassuring"
    | "expert"
    | "confident"
    | "sharp"
    | "bold"
    | "personal";
  paceOverride?: "slow_medium" | "medium" | "medium_fast" | "fast";
};

export type ScriptType =
  | "moment"
  | "reaction"
  | "demo"
  | "authority"
  | "mistake"
  | "comparison"
  | "story"
  | "direct";

function getScriptTypeFromOverrides(input: Input): ScriptType | null {
  if (input.toneOverride === "direct") {
    return "direct";
  }

  if (input.toneOverride === "personal") {
    return "story";
  }

  if (input.toneOverride === "expert") {
    return "authority";
  }

  if (input.toneOverride === "sharp") {
    return "comparison";
  }

  if (input.toneOverride === "confident") {
    return "demo";
  }

  if (input.toneOverride === "reassuring") {
    return "story";
  }

  if (input.toneOverride === "bold") {
    return "reaction";
  }

  if (input.paceOverride === "fast") {
    return "direct";
  }

  if (input.paceOverride === "medium_fast") {
    return "comparison";
  }

  if (input.paceOverride === "slow_medium") {
    return "story";
  }

  return null;
}

export function decideScriptType(input: Input): ScriptType {
  const fromOverrides = getScriptTypeFromOverrides(input);

  if (fromOverrides) {
    return fromOverrides;
  }

  const isVideo =
    input.selectedFormat === "reel" || input.selectedFormat === "video";

  if (input.goal === "exposure") {
    if (isVideo) {
      return Math.random() > 0.5 ? "moment" : "reaction";
    }

    return "moment";
  }

  if (input.goal === "trust") {
    return Math.random() > 0.5 ? "authority" : "demo";
  }

  if (input.goal === "sales") {
    return Math.random() > 0.5 ? "direct" : "comparison";
  }

  if (input.goal === "leads") {
    if (input.intent === "message") {
      return Math.random() > 0.5 ? "direct" : "mistake";
    }

    return isVideo ? "reaction" : "direct";
  }

  return "moment";
}