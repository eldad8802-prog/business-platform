import type { LocalizationRules } from "./content/localization.service";

type ScriptCheckInput = {
  scriptText: string;
  shots: { visual: string; voice: string }[];
  hookText?: string;
  caption?: string;
  variantId?: "desire" | "trust" | "result";
  distributionGoal?: "retention" | "comments" | "shares" | "saves";
  localizationRules?: LocalizationRules;
};

export type QualityResult = {
  score: number;
  issues: string[];
  shouldRegenerate: boolean;
};

const BAD_PATTERNS = [
  "רוב האנשים",
  "יש דרך",
  "אם גם אתה",
  "העסק שלך",
  "הגיע הזמן",
  "אנו מציעים",
  "לקוחות רבים",
  "פתרון מושלם",
];

function hasAny(text: string, values: string[]) {
  return values.some((value) => text.includes(value));
}

export function analyzeContentQuality(
  input: ScriptCheckInput
): QualityResult {
  let score = 100;
  const issues: string[] = [];
  const text = input.scriptText || "";
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) || "";
  const fullText = `${input.scriptText}\n${input.caption || ""}`;

  BAD_PATTERNS.forEach((bad) => {
    if (fullText.includes(bad)) {
      score -= 12;
      issues.push(`טקסט גנרי: ${bad}`);
    }
  });

  if (input.localizationRules) {
    input.localizationRules.bannedPhrases.forEach((bad) => {
      if (fullText.includes(bad)) {
        score -= 8;
        issues.push(`ניסוח לא מקומי מספיק: ${bad}`);
      }
    });
  }

  if (firstLine.length < 12) {
    score -= 18;
    issues.push("hook קצר מדי");
  }

  if (
    !firstLine.includes("—") &&
    !firstLine.includes("!") &&
    !firstLine.includes("?") &&
    firstLine.length < 22
  ) {
    score -= 10;
    issues.push("hook לא חד מספיק");
  }

  if (input.hookText && !text.includes(input.hookText.trim())) {
    score -= 10;
    issues.push("ה-hook שנבחר לא נשמר בצורה ברורה בתסריט");
  }

  if (input.shots.length < 3) {
    score -= 18;
    issues.push("מעט מדי שוטים");
  }

  if (input.shots.length > 5) {
    score -= 8;
    issues.push("יותר מדי שוטים");
  }

  input.shots.forEach((shot, index) => {
    if (!shot.visual || shot.visual.length < 10) {
      score -= 8;
      issues.push(`שוט ${index + 1} לא מספיק ויזואלי`);
    }

    if (!shot.voice || shot.voice.length < 5) {
      score -= 8;
      issues.push(`שוט ${index + 1} חסר טקסט`);
    }
  });

  if (input.variantId === "trust") {
    if (!hasAny(fullText, ["תהליך", "מדויק", "נכון", "מקצוע", "הבדל"])) {
      score -= 10;
      issues.push("וריאציית אמון בלי שפה של מקצועיות או תהליך");
    }
  }

  if (input.variantId === "result") {
    if (!hasAny(fullText, ["תוצאה", "עובד", "הבדל", "שלחו", "הזמינו"])) {
      score -= 10;
      issues.push("וריאציית תוצאה בלי תחושת payoff או פעולה");
    }
  }

  if (input.variantId === "desire") {
    if (!hasAny(fullText, ["תראה", "תעצור", "חכה", "קשה להתעלם", "אל תגלול"])) {
      score -= 10;
      issues.push("וריאציית משיכה בלי תחושת עצירת גלילה");
    }
  }

  if (input.distributionGoal === "comments") {
    if (!hasAny(fullText, ["שלחו", "הזמינו", "הודעה", "כתבו"])) {
      score -= 8;
      issues.push("חסר טריגר תגובה או פעולה");
    }
  }

  if (input.distributionGoal === "saves") {
    if (!hasAny(fullText, ["תשמרו", "שמור", "ככה", "טעות", "שלב"])) {
      score -= 8;
      issues.push("חסר ערך שמרגיש שווה שמירה");
    }
  }

  if (input.distributionGoal === "shares") {
    if (!hasAny(fullText, ["תראה", "אי אפשר", "כולם", "קשה להתעלם"])) {
      score -= 8;
      issues.push("חסר טריגר שיתוף או רגש");
    }
  }

  if (text.split("\n").filter((line) => line.trim().length > 0).length < 3) {
    score -= 8;
    issues.push("התסריט קצר מדי");
  }

  return {
    score,
    issues,
    shouldRegenerate: score < 72,
  };
}