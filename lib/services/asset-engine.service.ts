import { CreatorContextProfile } from "./creator-context-interpreter.service";
import { CreativeStrategy } from "./creative-strategy.service";

export function runAssetEngine(input: {
  videoType: string;
  mode: string;
  creatorProfile?: CreatorContextProfile;
  creativeStrategy?: CreativeStrategy;
}) {
  const assets: any[] = [];
  const profile = input.creatorProfile;
  const strategy = input.creativeStrategy;

  if (!profile || !strategy) {
    return {
      requiredAssets: [],
      optionalAssets: [],
      guidance: [],
    };
  }

  // -------------------------
  // DESIRE (food etc)
  // -------------------------
  if (strategy.contentPillar === "desire") {
    assets.push({
      id: "process",
      title: "צילום תהליך",
      description: "צלם את שלבי ההכנה מקרוב בצורה מגרה",
      type: "video",
      required: true,
    });

    assets.push({
      id: "result",
      title: "צילום תוצאה",
      description: "צלם את התוצאה הסופית בצורה מושכת",
      type: "image",
      required: true,
    });
  }

  // -------------------------
  // TRUST
  // -------------------------
  if (strategy.contentPillar === "trust") {
    assets.push({
      id: "talk",
      title: "דיבור למצלמה",
      description: "הסבר קצר למצלמה על השירות שלך",
      type: "video",
      required: true,
    });
  }

  // -------------------------
  // FALLBACK
  // -------------------------
  if (assets.length === 0) {
    assets.push({
      id: "main",
      title: "צילום מרכזי",
      description: "העלה צילום שמייצג את התוכן",
      type: "video",
      required: true,
    });
  }

  return {
    requiredAssets: assets,
    optionalAssets: [],
    guidance: ["צלם באור טוב", "שמור על יציבות"],
  };
}