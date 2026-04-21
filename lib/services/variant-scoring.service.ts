type IdeaType = "desire" | "education" | "trust";

type SelectVariantInput = {
  variants: any[];
  goal: "leads" | "trust" | "exposure" | "sales";
  intent: "message" | "follow" | "watch" | "sale";
  format: "reel" | "video" | "image" | "post";
};

function getGoalScore(goal: string, ideaType: IdeaType): number {
  if (goal === "leads" || goal === "sales") {
    if (ideaType === "desire") return 3;
    if (ideaType === "trust") return 2;
    return 1;
  }

  if (goal === "trust") {
    if (ideaType === "trust") return 3;
    if (ideaType === "education") return 2;
    return 1;
  }

  if (goal === "exposure") {
    if (ideaType === "education") return 3;
    if (ideaType === "desire") return 2;
    return 1;
  }

  return 1;
}

function getIntentScore(intent: string, ideaType: IdeaType): number {
  if (intent === "message" || intent === "sale") {
    if (ideaType === "desire") return 3;
    if (ideaType === "trust") return 2;
    return 1;
  }

  if (intent === "follow") {
    if (ideaType === "education") return 3;
    if (ideaType === "trust") return 2;
    return 1;
  }

  if (intent === "watch") {
    if (ideaType === "education") return 3;
    return 2;
  }

  return 1;
}

function getFormatScore(format: string, ideaType: IdeaType): number {
  if (format === "reel") {
    if (ideaType === "desire") return 3;
    return 2;
  }

  if (format === "video") {
    if (ideaType === "education") return 3;
    if (ideaType === "trust") return 2;
    return 1;
  }

  if (format === "image") {
    if (ideaType === "desire") return 3;
    return 1;
  }

  if (format === "post") {
    if (ideaType === "trust") return 3;
    if (ideaType === "education") return 2;
    return 1;
  }

  return 1;
}

export function selectBestVariant(input: SelectVariantInput) {
  const { variants, goal, intent, format } = input;

  let bestVariant = variants[0];
  let bestScore = -Infinity;

  for (const variant of variants) {
    const ideaType = variant.ideaType as IdeaType;

    const score =
      getGoalScore(goal, ideaType) +
      getIntentScore(intent, ideaType) +
      getFormatScore(format, ideaType) +
      Math.random() * 0.5; // variation factor

    if (score > bestScore) {
      bestScore = score;
      bestVariant = variant;
    }
  }

  return bestVariant;
}